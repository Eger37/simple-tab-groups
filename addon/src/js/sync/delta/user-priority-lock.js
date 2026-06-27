/**
 * USER-priority concurrency lock for the group/tab store (Phase: sync-user-priority).
 *
 * ## The race this fixes
 * Delta-sync's local APPLY (`delta-sync.js` `applyBrowserOps`/`applyPinnedOps`) does a
 * `Groups.load(null,false)` → modify → `Groups.save(nextGroups)`. USER-initiated group
 * mutations (`Groups.remove`/`add`/`move`/`sort`/...) do their OWN `load → splice → save`.
 * `Groups.save` is a blind `Storage.set({groups})` with no merge, so a user deletion that
 * interleaves with a concurrent sync apply is a lost update: the manual delete's `save`
 * is overwritten by the sync's `save` (or vice-versa), the group survives in the cloud and
 * resurrects, and the user's action silently fails. The old `inProgress` guard in
 * delta-sync serializes sync-vs-sync ONLY, never sync-vs-user.
 *
 * ## Policy (exact)
 * 1. USER actions have PRIORITY. While the user is mutating, sync must WAIT and must NOT
 *    interleave.
 * 2. If the user STARTS an action while sync is about to apply, sync YIELDS: it DEFERS
 *    applying this cycle and reschedules soon (sync is periodic — deferring one cycle is
 *    cheap). The user NEVER waits on a long sync.
 * 3. Sync stays FAST: the lock is held ONLY around the short local apply critical section,
 *    NEVER around network pull/push.
 * 4. Apply and user mutations are mutually exclusive (no interleaved load/modify/save).
 *
 * ## Mechanism — why a promise-chain mutex (not `navigator.locks`)
 * A tiny single-tail promise-chain mutex: every critical section is appended to a shared
 * `tail` Promise and runs only after the previous one settles. This is chosen over the
 * WebExtensions `navigator.locks` API because:
 *   - the DEFER-on-user-active semantics (sync must give up rather than queue behind the
 *     user) need a synchronously-readable "user active" signal + a non-blocking
 *     try-acquire, which `navigator.locks` only models via `ifAvailable` + an extra
 *     promise dance — strictly more moving parts for no gain here;
 *   - it is PURE (no `browser.*`, no runtime feature-detection in the MV2 background page)
 *     so it unit-tests directly as a `.mjs` with the rest of the delta pipeline;
 *   - the critical sections are all in ONE persistent background page (single JS realm),
 *     so the cross-context guarantees `navigator.locks` adds are unnecessary.
 *
 * The mutex NEVER lets one failed critical section wedge the lock forever — it always
 * releases (in `finally`) and swallows the prior section's rejection when waiting its turn,
 * so callers still get their own result/throw via the returned promise.
 *
 * @module sync/delta/user-priority-lock
 */

// Single shared promise tail. Each runExclusive() appends to it; the next waiter starts
// only after the previous critical section settles. Resolved-to-start.
let tail = Promise.resolve();

// "User is mutating" signal. Set for the duration of a user mutation's critical section
// PLUS a short trailing window (covers a burst of rapid edits — a user dragging several
// groups in a row shouldn't let a sync slip in between). Synchronously readable so the
// sync side can decide to DEFER without awaiting.
let userActiveCount = 0;          // # of in-flight user critical sections (re-entrant safe)
let trailingTimer = null;         // trailing-window timer handle
let trailingUntil = 0;            // epoch ms until which we still count as user-active

// Default trailing window after a user mutation's critical section ends. A few hundred ms
// is enough to bridge a rapid burst of edits without meaningfully starving sync (which is
// periodic). Exposed/overridable for tests.
export const DEFAULT_TRAILING_MS = 400;

// Default safety timeout for the SYNC side acquiring the lock. Sync should never wait
// forever on a user critical section (which itself is short and always releases): if it
// can't get in within this window it gives up and DEFERS this cycle. Tunable per call.
export const DEFAULT_SYNC_ACQUIRE_TIMEOUT_MS = 5_000;

// Default COMPLETION watchdog for the sync apply critical section. The acquisition
// timeout above governs only getting INTO the lock; once the apply `fn` starts it runs
// to completion holding the lock. If any await inside the apply never settles, the mutex
// would never release and EVERY future user mutation (which all queue on the same tail)
// would hang forever — the reported post-sync UI freeze. This watchdog bounds how long
// the apply may HOLD the lock: when it trips we stop waiting on the apply, let the
// critical section settle (so the normal `finally` release hands the lock to the next
// waiter), and let the in-flight apply keep running DETACHED in the background. Generous
// — well above any legitimate apply (a real apply of dozens of tabs is a few seconds per
// the debug logs); it exists only to self-recover from a never-settling await.
export const DEFAULT_SYNC_APPLY_WATCHDOG_MS = 60_000;

/**
 * Is the user currently mutating (in a critical section OR inside the trailing window)?
 * Synchronous so the sync side can branch on it without awaiting.
 * @returns {boolean}
 */
export function isUserActive() {
    return userActiveCount > 0 || Date.now() < trailingUntil;
}

/**
 * Run `fn` as an exclusive critical section: it starts only after every previously-queued
 * section settles, and the next waiter starts only after `fn` settles. The lock is held
 * for EXACTLY the duration of `fn` — keep `fn` short and never await network/user-prompts
 * inside it. Always releases (even if `fn` throws); the caller still sees `fn`'s
 * result/rejection.
 * @template T
 * @param {() => (T | Promise<T>)} fn
 * @returns {Promise<T>}
 */
export function runExclusive(fn) {
    // chain a barrier the previous tail must clear; `release` lets the NEXT waiter proceed.
    const {promise: gate, resolve: release} = withResolvers();
    const previous = tail;
    tail = gate; // everyone after us waits on our gate

    return (async () => {
        try {
            await previous; // wait our turn
        } catch {
            // a prior section's failure must not block us; its own caller already saw it.
        }
        try {
            return await fn();
        } finally {
            release(); // hand the lock to the next waiter no matter what
        }
    })();
}

/**
 * Mark the start of a USER mutation. Increments the active count and (re)arms the trailing
 * window. MUST be paired with {@link endUserMutation} in a `finally`. Prefer
 * {@link runUserMutation}, which pairs them for you.
 * @param {number} [trailingMs=DEFAULT_TRAILING_MS]
 */
export function beginUserMutation(trailingMs = DEFAULT_TRAILING_MS) {
    userActiveCount++;
    // while a section is in-flight the count alone keeps us active; pre-extend the trailing
    // mark so an immediately-following endUserMutation still leaves a window even if the
    // timer below hasn't been (re)armed yet.
    trailingUntil = Math.max(trailingUntil, Date.now() + trailingMs);
}

/**
 * Mark the end of a USER mutation. Decrements the active count and arms the trailing
 * window so a rapid follow-up edit still counts as user-active (sync keeps deferring).
 * @param {number} [trailingMs=DEFAULT_TRAILING_MS]
 */
export function endUserMutation(trailingMs = DEFAULT_TRAILING_MS) {
    if (userActiveCount > 0) {
        userActiveCount--;
    }
    if (userActiveCount === 0) {
        trailingUntil = Date.now() + trailingMs;
        if (trailingTimer) {
            clearTimeout(trailingTimer);
        }
        // a no-op timer that just lets the window lapse; isUserActive() reads trailingUntil
        // directly, so this only deterministically clears the handle (and gives tests a hook).
        // Guard for environments without setTimeout (none in the bg page).
        if (typeof setTimeout === 'function') {
            trailingTimer = setTimeout(() => {
                trailingTimer = null;
            }, trailingMs);
        }
    }
}

/**
 * Run a USER mutation's critical section with PRIORITY: marks the user active for the
 * duration + trailing window AND takes the mutex so it can't interleave with a sync apply.
 * The user never DEFERS — they always get the lock (sync's hold is short and bounded).
 * @template T
 * @param {() => (T | Promise<T>)} fn
 * @param {number} [trailingMs=DEFAULT_TRAILING_MS]
 * @returns {Promise<T>}
 */
export function runUserMutation(fn, trailingMs = DEFAULT_TRAILING_MS) {
    beginUserMutation(trailingMs);
    return runExclusive(fn).finally(() => endUserMutation(trailingMs));
}

/**
 * Run the SYNC apply critical section, YIELDING to the user.
 *
 * Behavior:
 *   - If the user is active RIGHT NOW (in a critical section or trailing window), DEFER
 *     immediately: do NOT run `fn`, return `{deferred: true}` so the caller reschedules.
 *   - Otherwise take the mutex with a safety timeout. If acquisition can't complete within
 *     `timeoutMs` (e.g. a user mutation slipped in and is holding it), DEFER too — sync
 *     never waits forever.
 *   - Once `fn` starts (we hold the lock) it is the short, bounded apply — but a COMPLETION
 *     WATCHDOG (`watchdogMs`) bounds how long it may HOLD the lock. If a never-settling await
 *     inside the apply keeps `fn` from resolving, the watchdog fires: we STOP waiting on the
 *     apply, the critical section settles (so the mutex's normal `finally` release frees the
 *     lock for the next waiter, e.g. a queued user mutation), and the in-flight apply is left
 *     to keep running DETACHED. We do NOT abort/rollback the in-flight browser ops; we only
 *     stop them from holding the lock hostage so user input can never wedge permanently.
 *     `onWatchdog()` (if given) is invoked so the caller can log WARN diagnostics.
 *
 * RELEASE-RACE / IDEMPOTENCY: the lock release is owned SOLELY by the mutex's `finally` in
 * {@link runExclusive}, which `release()`s exactly once when the critical-section function
 * settles. We never force-release here. When the watchdog fires near the deadline AND the
 * apply finishes ~simultaneously, only ONE thing settles the critical section: a `settled`
 * guard flag ensures the section's function returns exactly once (either the apply's value or
 * the watchdog's marker), so `release()` fires exactly once for THIS section. The detached
 * apply continuing afterward touches no lock state — it has no `release` handle — so it can
 * neither double-release nor release a newer section.
 *
 * @template T
 * @param {() => (T | Promise<T>)} fn  the apply critical section (short; no network inside).
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=DEFAULT_SYNC_ACQUIRE_TIMEOUT_MS] acquisition safety timeout.
 * @param {number} [opts.watchdogMs=DEFAULT_SYNC_APPLY_WATCHDOG_MS] completion watchdog (held-lock bound).
 * @param {(info: {elapsedMs: number}) => void} [opts.onWatchdog] called once if the watchdog trips.
 * @returns {Promise<{deferred: boolean, result?: T, watchdog?: boolean}>}
 */
export async function runSyncApply(fn, {
    timeoutMs = DEFAULT_SYNC_ACQUIRE_TIMEOUT_MS,
    watchdogMs = DEFAULT_SYNC_APPLY_WATCHDOG_MS,
    onWatchdog,
} = {}) {
    // 1. fast pre-check: user active ⇒ defer without touching the lock at all.
    if (isUserActive()) {
        return {deferred: true};
    }

    // 2. race lock acquisition against a safety timeout. If the timeout wins we DEFER; the
    // queued critical section then no-ops (it re-checks `timedOut`) so it never runs the
    // apply after we've already given up, and the chain still advances cleanly.
    let acquired = false;
    let timedOut = false;

    const {promise: timeoutPromise, resolve: fireTimeout} = withResolvers();
    const timer = (typeof setTimeout === 'function')
        ? setTimeout(() => {
            timedOut = true;
            fireTimeout({deferred: true});
        }, timeoutMs)
        : null;

    const exclusive = runExclusive(async () => {
        if (timedOut) {
            return {deferred: true}; // timeout already won; do nothing under lock.
        }
        // re-check the user signal now that we actually hold the lock: a user mutation could
        // have started+finished while we waited in the chain. Belt-and-suspenders (the user
        // path takes the lock too, so it can't be mid-mutation here), but cheap.
        if (isUserActive()) {
            return {deferred: true};
        }
        acquired = true;

        // COMPLETION WATCHDOG: race the apply against a generous timeout. Whichever settles
        // FIRST decides this critical section's return value (and thus when the mutex releases
        // the lock for the next waiter). A `settled` guard makes the section resolve exactly
        // once even if the apply finishes the same tick the watchdog fires — so `release()`
        // (owned by runExclusive's finally) is never raced into a double-release.
        const startedAt = Date.now();
        let settled = false;
        const {promise: watchdogPromise, resolve: fireWatchdog} = withResolvers();
        const watchdogTimer = (typeof setTimeout === 'function')
            ? setTimeout(() => {
                if (settled) {
                    return; // apply already won the race; leave the lock to the normal path.
                }
                const elapsedMs = Date.now() - startedAt;
                if (typeof onWatchdog === 'function') {
                    try {
                        onWatchdog({elapsedMs});
                    } catch {
                        // diagnostics must never break the safety release.
                    }
                }
                // settling THIS section frees the lock via runExclusive's finally; the
                // in-flight apply keeps running detached (we intentionally do not await it).
                fireWatchdog({deferred: false, watchdog: true});
            }, watchdogMs)
            : null;

        // Run the apply and mark `settled` the instant it settles (resolve OR reject) so a
        // watchdog firing on the same tick becomes a no-op (it checks `settled`), and clear
        // the watchdog timer. A rejection still settles the section (and releases the lock)
        // with the error — the watchdog only matters when the apply NEVER settles.
        const guardedApply = Promise.resolve().then(fn)
            .then(result => ({deferred: false, result}))
            .finally(() => {
                settled = true;
                if (watchdogTimer) {
                    clearTimeout(watchdogTimer);
                }
            });

        // If the watchdog wins the race below, this section settles via `watchdogPromise` and
        // `guardedApply` is left running DETACHED. Swallow its eventual rejection so a later
        // failure of the abandoned apply can't surface as an unhandledRejection (the original
        // caller has already moved on; a detached apply is best-effort). This catch does NOT
        // affect the race: `Promise.race` reads `guardedApply`'s own settlement, not this fork.
        guardedApply.catch(() => {});

        return Promise.race([guardedApply, watchdogPromise]);
    });

    try {
        const winner = await Promise.race([exclusive, timeoutPromise]);
        // If our section actually ran the apply, return its outcome; otherwise DEFER.
        return acquired ? winner : {deferred: true};
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}

/**
 * Cross-realm shim for Promise.withResolvers (older Firefox in the test runner may lack it).
 * Tiny and local so the module has no external dependency.
 */
function withResolvers() {
    if (typeof Promise.withResolvers === 'function') {
        return Promise.withResolvers();
    }
    let resolve, reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return {promise, resolve, reject};
}

/**
 * TEST-ONLY: reset all module state to pristine. Not used by production code.
 */
export function __resetForTests() {
    tail = Promise.resolve();
    userActiveCount = 0;
    trailingUntil = 0;
    if (trailingTimer) {
        clearTimeout(trailingTimer);
        trailingTimer = null;
    }
}
