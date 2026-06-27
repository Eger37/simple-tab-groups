
/**
 * Backward-compat seed for hybrid snapshot + delta sync (Phase P3a).
 *
 * Existing users sync via the OLD single-file `STG-backup.json`, a full-state
 * backup ({ groups, ...options, containers }). The delta era needs an initial
 * `STG-snapshot.json` of the shape the replay engine consumes
 * (`{ groups, watermark }`). This helper produces that initial snapshot from an
 * old backup WITHOUT discarding it: the groups/tabs already exist, so we just wrap
 * them and add an empty watermark (nothing has been folded yet).
 *
 * ## How P3b will use it (documented, not wired here)
 * When the transport pulls the gist: if `STG-snapshot.json` is ABSENT but
 * `STG-backup.json` is present (a pre-delta user's first delta sync), read the old
 * backup, run {@link seedSnapshotFromLegacyBackup} on it, and treat the result as
 * `pulledSnapshot`. The old file is left in place (the classic `cloud.js` sync flow
 * still reads/writes it until fully migrated). The first delta-era write then
 * PATCHes `STG-snapshot.json`; replay on top of an empty watermark replays every
 * pulled delta event, so no work is lost.
 *
 * ## Purity
 * PURE: literals only, deep-clones its input, never mutates it, no `browser.*` and
 * no `constants.js` import — so it runs/tests under plain `node`.
 *
 * @module sync/delta/seed
 */

/**
 * Deep clone of a plain JSON-ish value (mirrors replay.js' deepClone to stay
 * import-free / obviously pure).
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepClone(value) {
    if (value === null || typeof value !== 'object') {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map(deepClone);
    }
    const out = {};
    for (const key of Object.keys(value)) {
        out[key] = deepClone(value[key]);
    }
    return out;
}

/**
 * Wrap an old single-file backup into an initial delta-era snapshot.
 *
 * `groups` (with their tabs) AND the global `pinnedTabs` carry over into the
 * replay-engine snapshot shape; the legacy backup already stores pinned tabs in
 * `data.pinnedTabs` (see `background.js` createBackup), so they map straight across.
 * The watermark starts empty (`{}`) so every subsequent delta event is replayed
 * (rule 4 dedup has nothing folded yet). The input is never mutated.
 *
 * @param {object} legacyBackup - parsed `STG-backup.json` ({ groups, pinnedTabs?, ...rest }).
 * @returns {{groups: object[], pinnedTabs: object[], watermark: object}} the seed snapshot.
 */
export function seedSnapshotFromLegacyBackup(legacyBackup) {
    const groups = Array.isArray(legacyBackup?.groups) ? deepClone(legacyBackup.groups) : [];
    const pinnedTabs = Array.isArray(legacyBackup?.pinnedTabs) ? deepClone(legacyBackup.pinnedTabs) : [];

    return {
        groups,
        pinnedTabs,
        watermark: {},
    };
}
