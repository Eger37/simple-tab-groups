
/**
 * Pure compaction policy for hybrid snapshot + delta sync (Phase P4).
 *
 * The cloud holds a consolidated BASE snapshot (`STG-snapshot.json`) carrying a
 * `watermark` map `{deviceId: seq}` — the highest delta `seq` from each device ALREADY
 * folded into the base — plus per-device append-only `STG-delta-<id>.json` logs. Replay
 * (`replay.js`) computes the effective state as `base + every event with seq > watermark`,
 * SKIPPING anything `seq <= watermark[device]` (replay.js dedup, the safety foundation).
 *
 * Two things grow unboundedly without compaction: the cloud rewrites the full snapshot
 * every cycle (wasteful), and the per-device delta logs are never truncated. This module
 * decides — PURELY — WHEN to compact and WHICH of THIS device's own events are safe to
 * truncate, so the impure transport (`delta-sync.js`) can act on it.
 *
 * ## What "folding" is (no second fold path)
 * The planner already replays `base + all pulled+pending events` into a RESOLVED snapshot
 * each cycle, and `replay()` returns that snapshot's `watermark` advanced to the max applied
 * `seq` per device. THAT resolved snapshot IS the folded base, and its watermark IS the
 * advanced watermark — there is no separate folding step here. Compaction is simply the
 * DECISION to (a) persist that resolved snapshot as the new base and (b) truncate the now-
 * folded events from this device's OWN log. We never recompute the fold a second, divergent
 * way; correctness rides entirely on the single pure replay engine.
 *
 * ## Trigger
 * When the number of UNFOLDED events — events whose `seq` exceeds the BASE (pre-replay)
 * watermark for their device, summed across ALL device delta logs this device pulled —
 * exceeds {@link COMPACTION_THRESHOLD}, the next successful sync compacts.
 *
 * ## Non-blocking w.r.t. lagging / lost devices (hard requirement)
 * The count and the fold use ONLY this device's pulled view. We do NOT gate on a
 * min-watermark across devices and we NEVER wait for other devices to catch up. We fold
 * ALL pulled events into the base, advancing EACH device's watermark to the highest folded
 * seq for that device. A behind/lost device that later returns pulls the NEW base (which
 * already contains the folded effect) plus whatever of its own deltas remain unfolded —
 * nothing is lost. A permanently-lost device's stale delta file simply lingers in the gist
 * and is skipped on replay (`seq <= watermark`); it is harmless, never a blocker.
 *
 * ## Own-log truncation only
 * A device may rewrite ONLY its own delta file (the transport writes this device's delta +
 * the snapshot, nothing else — confirmed in delta-sync.js). So here we compute the highest
 * SELF seq that the new base has folded ({@link selfFoldedSeq}); the transport truncates the
 * local {@link module:sync/delta/delta-log} up to it and writes back only the self events
 * with `seq` beyond it. Other devices' stale events are NOT rewritten — the advanced
 * watermark already makes replay skip them, and a returning device still owns its own file.
 *
 * ## Purity
 * No `browser.*`, no network, no `constants.js`. Reads its inputs, returns plain data.
 *
 * @module sync/delta/compaction
 */

/**
 * Compact once the unfolded-event count EXCEEDS this many. A modest cap: large enough that
 * a normal session's deltas accumulate cheaply between compactions, small enough that the
 * logs never grow without bound. Compaction is the only time the full snapshot is rewritten.
 * @type {number}
 */
export const COMPACTION_THRESHOLD = 100;

/**
 * Count the UNFOLDED events across all pulled device delta logs — events whose `seq`
 * strictly exceeds the BASE (pre-replay) watermark for their device. This mirrors EXACTLY
 * the replay dedup predicate (`event.seq > baseWatermark[deviceId]`, see replay.js), so the
 * count equals the number of events replay will actually fold this cycle. Events at/below
 * the watermark are already in the base and are not counted (nor folded, nor truncated).
 *
 * A null/`undefined` `seq` is treated as unfolded (counted) — it can never be `<=` a numeric
 * watermark, matching replay, which only skips when `seq != null && seq <= folded`.
 *
 * @param {Array<{deviceId: string, events: object[]}>} pulledDeltaLogs - logs as pulled.
 * @param {object} [baseWatermark] - the snapshot's watermark BEFORE this cycle's replay.
 * @returns {number} count of events with seq beyond their device's base watermark.
 */
export function countUnfoldedEvents(pulledDeltaLogs, baseWatermark = {}) {
    const wm = baseWatermark || {};
    let count = 0;

    for (const log of pulledDeltaLogs || []) {
        const folded = wm[log?.deviceId] ?? 0;
        for (const event of log?.events || []) {
            if (event.seq == null || event.seq > folded) {
                count += 1;
            }
        }
    }

    return count;
}

/**
 * Decide whether THIS cycle should compact: true iff the unfolded-event count EXCEEDS
 * {@link COMPACTION_THRESHOLD}. Pure predicate over the pulled logs + base watermark.
 *
 * @param {Array<{deviceId: string, events: object[]}>} pulledDeltaLogs
 * @param {object} [baseWatermark]
 * @param {number} [threshold] - override (tests); defaults to {@link COMPACTION_THRESHOLD}.
 * @returns {{shouldCompact: boolean, unfoldedCount: number}}
 */
export function evaluateCompaction(pulledDeltaLogs, baseWatermark = {}, threshold = COMPACTION_THRESHOLD) {
    const unfoldedCount = countUnfoldedEvents(pulledDeltaLogs, baseWatermark);
    return {shouldCompact: unfoldedCount > threshold, unfoldedCount};
}

/**
 * The highest SELF seq that the NEW base has folded — i.e. how far this device may safely
 * truncate its OWN local log. It is the advanced watermark for `selfDeviceId` in the resolved
 * snapshot (the new base), which `replay()` set to the max applied self `seq`. We additionally
 * CLAMP it to `lastPushedSeq`: the local log may hold freshly-captured events whose seq is
 * higher than anything that reached the cloud / the resolved snapshot this cycle, and those
 * are NOT yet in the base — truncating them would lose them. Taking the MIN is the conservative
 * choice ("never truncate an event whose effect isn't in the new base"): we trim only events
 * that are BOTH folded into the new base AND already pushed.
 *
 * @param {object} newWatermark - the resolved snapshot's advanced watermark `{deviceId: seq}`.
 * @param {string} selfDeviceId
 * @param {number} [lastPushedSeq=0] - highest self seq already pushed to the cloud.
 * @returns {number} the seq to pass to DeltaLog.clearUpTo (0 ⇒ nothing to truncate).
 */
export function selfFoldedSeq(newWatermark, selfDeviceId, lastPushedSeq = 0) {
    const foldedSelf = (newWatermark || {})[selfDeviceId] ?? 0;
    const pushed = Number.isFinite(lastPushedSeq) ? lastPushedSeq : 0;
    return Math.min(foldedSelf, pushed);
}

/**
 * From the self events the planner would write (`deltaFileToWrite.events`, the FULL self log
 * in portable form), keep only those with `seq` STRICTLY GREATER than `foldedSeq` — i.e. the
 * events NOT yet folded into the new base. This is the cloud-side counterpart to the local
 * {@link module:sync/delta/delta-log.clearUpTo}: after compaction the self delta file holds
 * only the still-unfolded tail, so the gist log stops growing. Events with a null seq are
 * KEPT (conservative: an un-sequenced event can't be proven folded).
 *
 * @param {object[]} selfEvents - the full self events the non-compacting path would write.
 * @param {number} foldedSeq - from {@link selfFoldedSeq}.
 * @returns {object[]} the retained (still-unfolded) self events, in order.
 */
export function truncateSelfEvents(selfEvents, foldedSeq) {
    return (selfEvents || []).filter(event => event.seq == null || event.seq > foldedSeq);
}

/**
 * DEFERRED SELF-TRUNCATION reconciliation (Part C, the data-loss backstop).
 *
 * ## Why truncation is deferred
 * The snapshot is the ONLY home of folded history — per-device delta files are truncated
 * TAILS, not a full replay source. If a compaction cycle truncated its own log (local
 * `clearUpTo` + a truncated cloud self-delta) in the SAME cycle it wrote the snapshot, and a
 * peer then CLOBBERED that just-written snapshot with an older one (the advisory lock makes
 * this rare but, lacking conditional writes, not impossible; a crash / expired lock can also
 * allow it), the just-truncated events would live ONLY in the clobbered snapshot ⇒ PERMANENT
 * LOSS. So a compaction cycle does NOT truncate; it records a pending marker = the self
 * watermark seq it folded into the snapshot it wrote, and keeps the full self log in BOTH the
 * local log and the cloud self-delta.
 *
 * ## The invariant
 * An event ALWAYS lives in either (a) a cloud delta file, or (b) a cloud snapshot whose
 * durability we have CONFIRMED by re-reading. We never truncate the only copy until confirmed.
 *
 * ## This function — the confirmation, run on a SUBSEQUENT cycle after pulling the snapshot
 * Given the pending marker and the PULLED cloud snapshot's self watermark, decide whether the
 * deferred truncation is now safe. It is safe iff the cloud snapshot durably carries those
 * folded events: `cloudSelfWatermark >= pendingTruncateSeq` (our snapshot survived, or a later
 * one supersedes it). Then truncate up to `pendingTruncateSeq` (local `clearUpTo` + drop
 * seq <= it from the cloud self-delta) and clear the marker. If the snapshot was CLOBBERED
 * (watermark rolled back below the marker), it is NOT safe: the events are still in the cloud
 * self-delta (we deferred), so they get re-folded; leave the marker so it resolves once the
 * cloud snapshot catches up.
 *
 * @param {?number} pendingTruncateSeq - the persisted pending marker (0/null ⇒ nothing pending).
 * @param {object} [cloudSnapshotWatermark] - the PULLED snapshot's watermark `{deviceId: seq}`.
 * @param {string} selfDeviceId
 * @returns {{confirmed: boolean, truncateSeq: number}} `confirmed` true iff it is now safe to
 *   truncate; `truncateSeq` is the seq to truncate up to (only meaningful when confirmed).
 */
export function resolveDeferredTruncation(pendingTruncateSeq, cloudSnapshotWatermark = {}, selfDeviceId) {
    const pending = Number(pendingTruncateSeq);
    if (!Number.isFinite(pending) || pending <= 0) {
        return {confirmed: false, truncateSeq: 0}; // nothing pending
    }
    const cloudSelfWatermark = Number((cloudSnapshotWatermark || {})[selfDeviceId]) || 0;
    if (cloudSelfWatermark >= pending) {
        return {confirmed: true, truncateSeq: pending}; // snapshot durably carries the folded events
    }
    return {confirmed: false, truncateSeq: 0}; // clobbered / not yet durable ⇒ keep deferring
}

/**
 * Is a single device's delta log FULLY FOLDED into the base — i.e. is EVERY event in it
 * already represented in the snapshot (so the file may be safely deleted)?
 *
 * The predicate is the EXACT per-event inverse of {@link countUnfoldedEvents} / replay's
 * dedup skip test (`event.seq != null && event.seq <= folded`, see replay.js): an event is
 * folded iff it has a numeric `seq` that is `<= watermark[device]`. A log is fully folded
 * iff EVERY event is folded. Equivalently it is NOT fully folded if ANY event is unfolded
 * (`seq == null || seq > folded`) — a `null`/missing seq is treated as UNFOLDED (it can
 * never be proven to be in the base, exactly as replay never skips it), so a file holding
 * one is NEVER deletable. An EMPTY log counts as fully folded (no event is outside the base).
 *
 * @param {object[]} events - the device's delta events (as pulled).
 * @param {number} [folded=0] - that device's watermark in the AUTHORITATIVE snapshot.
 * @returns {boolean} true iff every event has a numeric seq <= folded.
 */
export function isLogFullyFolded(events, folded = 0) {
    const wm = Number.isFinite(folded) ? folded : 0;
    for (const event of events || []) {
        if (event.seq == null || event.seq > wm) {
            return false; // an unfolded event ⇒ NOT safe to delete (would lose data)
        }
    }
    return true;
}

/**
 * Pure orphan-GC policy: from the pulled per-device delta files, select the names of files
 * SAFE to delete because they are FULLY FOLDED into the AUTHORITATIVE base — every one of
 * their events has `seq <= watermark[device]`, so the base already carries their effect and
 * replay would skip them all (`seq <= watermark`, see replay.js). Deleting such a file loses
 * NOTHING, and a device that later returns and re-pushes its full local log stays safe: those
 * events (`seq <= watermark`) are skipped by replay's dedup — no double-apply, no
 * resurrection. This relies on the watermark ENTRY being kept forever; this function NEVER
 * mutates the watermark (it only reads it), so that invariant is preserved by construction.
 *
 * STRICT SAFETY (the task's rules 1-6):
 *   - The CURRENT device's own file is NEVER selected (rule 1): it manages its own log via
 *     own-log truncation. Matched by deviceId.
 *   - A file is selected ONLY when {@link isLogFullyFolded} holds against the AUTHORITATIVE
 *     watermark passed in (rules 2 & 4) — ANY unfolded event keeps the file.
 *   - Watermark ENTRIES are not touched (rule 3): this returns names, never mutates `watermark`.
 *   - Bias to KEEP (rule 6): a file with no resolvable name, a null deviceId, or any doubt is
 *     skipped (never returned for deletion).
 *
 * @param {Array<{name?: string, deviceId: string, events: object[]}>} pulledDeltaLogs - the
 *   per-device logs as pulled, each carrying the gist file `name` it was read from.
 * @param {object} [watermark] - the AUTHORITATIVE (resolved/snapshot) watermark `{deviceId: seq}`.
 * @param {?string} [selfDeviceId] - the current device; its own file is never selected.
 * @returns {string[]} gist file names safe to delete (possibly empty), in input order.
 */
export function selectOrphanDeltaFilesToDelete(pulledDeltaLogs, watermark = {}, selfDeviceId = null) {
    const wm = watermark || {};
    const toDelete = [];

    for (const log of pulledDeltaLogs || []) {
        const deviceId = log?.deviceId;
        const name = log?.name;

        // bias to keep: no usable file name, or no device identity, or it's our own file.
        if (!name || deviceId == null || deviceId === selfDeviceId) {
            continue;
        }

        const folded = wm[deviceId] ?? 0;
        if (isLogFullyFolded(log?.events, folded)) {
            toDelete.push(name);
        }
    }

    return toDelete;
}
