
/**
 * Single source of truth for WHICH global option keys roam through delta sync.
 *
 * STG persists a flat bag of option values (see `constants.js` `ALL_OPTION_KEYS` /
 * `DEFAULT_OPTIONS`). Most are user preferences that should follow the user between
 * machines; a few are inherently per-device / local and must stay put. This module
 * holds the ONE predicate that decides "does this option key sync?", so the capture
 * layer (which appends `option.set` deltas) and the transport (which bootstraps +
 * applies them) agree exactly on the synced subset.
 *
 * ## What stays local (mirrors the OLD `cloud.js` `syncOptions()` exclusions)
 * Keys whose name starts with any of {@link LOCAL_ONLY_OPTION_KEY_PREFIXES} are NOT
 * synced:
 *   - `sync*`       — sync provider/token/interval/location/lastUpdate are per-device
 *                     (the token in particular must never roam to another machine);
 *   - `autoBackup*` — local backup schedule + paths are per-device.
 *
 * ## What DOES sync (intentional parity change vs. the old code)
 * Everything else in `ALL_OPTION_KEYS`, INCLUDING `defaultGroupProps` and `hotkeys`
 * (the old `syncOptions()` excluded `defaultGroupProps` from its loop and merged it
 * separately; here both roam as plain `option.set` values for full parity per the
 * client request). `groups` / `version` are NOT option keys (`NON_OPTION_KEYS`) and
 * never reach here — groups are synced by the group/tab delta ops.
 *
 * ## Purity
 * This module is PURE (no `browser.*`, no `constants.js` import): {@link isSyncedOptionKey}
 * is a string predicate, so the pure replay/plan-sync engines can use it directly. The
 * IMPURE callers (capture / transport) pass it `Constants.ALL_OPTION_KEYS` to derive the
 * concrete synced key list via {@link syncedOptionKeys}.
 *
 * @module sync/delta/option-keys
 */

/**
 * Option-key name prefixes that are per-device / local and must NOT sync. Mirrors the
 * OLD `cloud.js` `EXCLUDE_OPTION_KEY_STARTS_WITH` minus `defaultGroupProps` (which now
 * syncs). Frozen so callers can reference it without accidental mutation.
 * @readonly
 */
export const LOCAL_ONLY_OPTION_KEY_PREFIXES = Object.freeze(['sync', 'autoBackup']);

/**
 * Exact option keys that are per-device and must NOT sync, even though they don't match
 * a local-only prefix:
 *   - `temporaryContainerTitle` — its default is a locale-derived i18n string, so syncing
 *     it would converge two differently-localed machines onto one locale's title (a
 *     cosmetic wart, not a feature). Per-device.
 *   - `autoSyncEnable` — whether THIS device runs sync on a timer is a per-device choice,
 *     like `syncEnable`. Its name lacks a `sync`/`autoBackup` prefix, so it is listed here
 *     explicitly rather than caught by {@link LOCAL_ONLY_OPTION_KEY_PREFIXES}.
 * @readonly
 */
export const LOCAL_ONLY_OPTION_KEYS = Object.freeze(['temporaryContainerTitle', 'autoSyncEnable']);

/**
 * Does this option key roam through delta sync? True unless its name starts with one
 * of {@link LOCAL_ONLY_OPTION_KEY_PREFIXES} or is listed in {@link LOCAL_ONLY_OPTION_KEYS}.
 * Pure string predicate.
 * @param {string} key
 * @returns {boolean}
 */
export function isSyncedOptionKey(key) {
    if (LOCAL_ONLY_OPTION_KEYS.includes(key)) {
        return false;
    }
    return !LOCAL_ONLY_OPTION_KEY_PREFIXES.some(prefix => key.startsWith(prefix));
}

/**
 * Filter a list of option keys down to the synced subset. The impure callers pass
 * `Constants.ALL_OPTION_KEYS` here so the concrete list always tracks the constants.
 * @param {string[]} allOptionKeys
 * @returns {string[]}
 */
export function syncedOptionKeys(allOptionKeys) {
    return (allOptionKeys || []).filter(isSyncedOptionKey);
}
