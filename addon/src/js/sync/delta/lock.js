
/**
 * Pure decision helpers for the advisory distributed sync lock (Part A).
 *
 * The lock is a single gist file ({@link module:sync/delta/layout.LOCK_FILE_NAME}) holding
 * `{deviceId, expiresAt}`, where `expiresAt` is an ABSOLUTE time on the SERVER clock (ms).
 * Its purpose is to serialize sync cycles across devices so two devices don't write the
 * snapshot concurrently and clobber it — GitHub has NO conditional write (an `If-Match`
 * PATCH returns a bare 400), so we cannot do an atomic compare-and-set. The lock is
 * therefore ADVISORY/best-effort: acquire = write-our-stamp THEN re-read to confirm we won
 * any race; if a peer's stamp came back instead, we lose and back off. A crashed holder's
 * stamp is reclaimed once it goes stale (server time past `expiresAt`). Deferred
 * self-truncation (see {@link module:sync/delta/compaction}) is the real data-safety
 * backstop; this lock only reduces how often two devices write the snapshot at once.
 *
 * ## Purity
 * No `browser.*`, no network, no `constants.js`. Reads inputs, returns plain data — so the
 * race/staleness decisions can be unit-tested without a live gist (the impure read/write/
 * confirm-delay lives in `../cloud/githubgist.js`, calling these to decide).
 *
 * @module sync/delta/lock
 */

/**
 * Lock time-to-live (ms). A holder's stamp is considered STALE — and so freely reclaimable
 * by any device — once the server clock passes `acquiredAt + LOCK_TTL_MS`. A full sync cycle
 * finishes well under this (there is a 60s apply watchdog), so the TTL only ever reclaims a
 * lock left behind by a crashed / killed device. 2 minutes per the design.
 * @type {number}
 */
export const LOCK_TTL_MS = 120000;

/**
 * Confirm re-read delay (ms) between writing our stamp and re-reading it to resolve a race.
 * Short — just long enough for a concurrent peer's write to become observable so exactly one
 * winner is read back. Kept here (not in the impure layer) so the value is documented next to
 * the protocol it serves.
 * @type {number}
 */
export const LOCK_CONFIRM_DELAY_MS = 1500;

/**
 * Is a parsed lock value STALE (its holder presumed gone) at the given server time? A null /
 * malformed lock (no numeric `expiresAt`) counts as stale — there is nothing valid to honor,
 * so it is freely reclaimable. Stale iff `serverNow >= expiresAt`.
 *
 * @param {?object} lock - the parsed lock content (`{deviceId, expiresAt}`) or null/absent.
 * @param {number} serverNow - the current SERVER time (ms).
 * @returns {boolean} true iff the lock is absent, malformed, or expired.
 */
export function isLockStale(lock, serverNow) {
    const expiresAt = Number(lock?.expiresAt);
    if (!Number.isFinite(expiresAt)) {
        return true; // absent / malformed ⇒ nothing valid to honor ⇒ reclaimable
    }
    return serverNow >= expiresAt;
}

/**
 * Decide, from the FIRST read of the lock file, whether this device may WRITE its stamp.
 * We may write when the lock is absent/stale, OR when it is already ours (re-entrant /
 * renewal). We may NOT write when it is held, fresh, and owned by another device.
 *
 * @param {?object} lock - the parsed lock content, or null if the file is absent.
 * @param {string} selfDeviceId
 * @param {number} serverNow - current SERVER time (ms).
 * @returns {boolean} true iff this device should write its stamp and proceed to confirm.
 */
export function canWriteLock(lock, selfDeviceId, serverNow) {
    if (isLockStale(lock, serverNow)) {
        return true;
    }
    return lock?.deviceId === selfDeviceId;
}

/**
 * Resolve the CONFIRM read: after writing our stamp and waiting, did WE win the lock? The
 * lock is ours iff the re-read stamp's `deviceId` is ours. (A peer that wrote last between
 * our write and our re-read wins instead — exactly one stamp survives the last write, and
 * the read-back reveals who.)
 *
 * @param {?object} confirmedLock - the parsed lock re-read after the confirm delay.
 * @param {string} selfDeviceId
 * @returns {boolean} true iff this device holds the lock (acquired).
 */
export function didWinLock(confirmedLock, selfDeviceId) {
    return confirmedLock?.deviceId === selfDeviceId;
}

/**
 * Build the lock stamp this device writes: `{deviceId, expiresAt}` with `expiresAt` an
 * absolute SERVER time `serverNow + ttlMs`.
 *
 * @param {string} selfDeviceId
 * @param {number} serverNow - current SERVER time (ms).
 * @param {number} [ttlMs] - lock lifetime; defaults to {@link LOCK_TTL_MS}.
 * @returns {{deviceId: string, expiresAt: number}}
 */
export function makeLockStamp(selfDeviceId, serverNow, ttlMs = LOCK_TTL_MS) {
    return {deviceId: selfDeviceId, expiresAt: serverNow + ttlMs};
}
