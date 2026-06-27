
/**
 * PURE decision for whether a sync-created tab should be created ASLEEP (discarded) or
 * LOADED, given the user's LOCAL-ONLY sync options.
 *
 * Two independent axes, because Firefox treats pinned tabs differently:
 *
 *   GROUP (non-pinned) tabs — "sleep by default, optionally wake some":
 *     - `syncSleepNewTabs` (default true): when FALSE nothing sleeps (legacy: every
 *       group tab is created loaded). When TRUE group tabs default to asleep.
 *     - `syncActivatePreviouslyActiveTabs` (default false): wake a tab that was loaded
 *       (not discarded) on the SOURCE machine — read from the record's additive `loaded`
 *       field (absent ⇒ treated as asleep, the safe default for old records).
 *
 *   PINNED tabs — "load by default, optionally sleep":
 *     - `syncSleepPinnedTabs` (default false): pinned tabs LOAD by default, because
 *       Firefox forbids creating a discarded pinned tab outright (`tabs.create` rejects
 *       `{discarded:true, pinned:true}` with "Pinned tabs cannot be created and
 *       discarded."). STG works around it via create-then-discard in `Tabs.create`, but
 *       that path is opt-in: pinned tabs only sleep when this flag is ON.
 *
 * This is the ONLY place the option semantics live, so the grouped-create and pinned-create
 * apply paths agree exactly. It is PURE (no `browser.*`, no constants import) so the node
 * tests can import it directly.
 *
 * NOTE: this decides the `discarded` HINT passed to `Tabs.create`. STG's own create path
 * still refuses to discard a tab that has no restorable URL or that it is making active
 * (about:/long-url/foreground tabs always load) — see `tabs.js`. So returning
 * `discarded: true` here is "sleep if possible", never a guarantee.
 *
 * @module sync/delta/tab-sleep
 */

/**
 * Should a sync-created tab be created discarded (asleep)?
 *
 * @param {object} tabRecord - the synced tab record being created. Only `record.loaded`
 *   (additive, true when the tab was loaded on the source) is consulted (group tabs only).
 * @param {boolean} isPinned - true for the global-pinned create path, false for group tabs.
 * @param {object} options - the resolved option bag (LOCAL values). Reads
 *   `syncSleepNewTabs`, `syncSleepPinnedTabs`, `syncActivatePreviouslyActiveTabs`.
 * @returns {boolean} true ⇒ create asleep (discarded); false ⇒ create loaded.
 */
export function shouldSleepSyncedTab(tabRecord, isPinned, options = {}) {
    if (isPinned) {
        // Pinned tabs LOAD by default (Firefox can't create them discarded; STG only
        // sleeps them via create-then-discard when the user explicitly opts in).
        return options.syncSleepPinnedTabs === true;
    }

    // group/non-pinned tabs: sleep-by-default OFF ⇒ legacy behavior, nothing sleeps.
    if (!options.syncSleepNewTabs) {
        return false;
    }

    // exception: user wants tabs that were active/loaded on the source machine
    // loaded here too. `loaded` is additive + true-only; absent ⇒ asleep.
    if (options.syncActivatePreviouslyActiveTabs && tabRecord && tabRecord.loaded === true) {
        return false;
    }

    // default: asleep.
    return true;
}

/**
 * Option keys this decision reads. Exported so the apply path can fetch exactly these
 * from storage in one call without drifting from the decision logic.
 * @readonly
 */
export const SLEEP_OPTION_KEYS = Object.freeze([
    'syncSleepNewTabs',
    'syncSleepPinnedTabs',
    'syncActivatePreviouslyActiveTabs',
]);
