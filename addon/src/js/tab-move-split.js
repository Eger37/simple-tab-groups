/**
 * Pure helpers for the "move tabs into a group" pinned/normal split.
 *
 * A browser-pinned tab can't ride the normal hide-based move into a group (a pinned tab
 * can't be hidden). Every move-into-group caller therefore routes pinned tabs through the
 * group-pin flow (unpin → move → flag group-pinned, at the front of the group's pinned
 * block) instead of dropping them + showing `pinnedTabsAreNotSupported`. The single
 * chokepoint is `Tabs.move`; this module holds the side-effect-free decision so it can be
 * unit-tested without the extension host and reused by callers that need the same split
 * (e.g. the popup/Manage `moveTabs` mixin, which must not discard a tab that became pinned).
 */

/**
 * True when this tab must be routed through the group-pin flow on a move into a group:
 * any browser-pinned tab. (A group-pinned tab reports `pinned: true` while its group is
 * loaded, so this also covers re-targeting an already group-pinned tab to another group.)
 *
 * @param {{pinned?: boolean} | null | undefined} tab
 * @returns {boolean}
 */
export function isPinnedNeedingGroupPin(tab) {
    return Boolean(tab) && tab.pinned === true;
}

/**
 * Partition tab ids for a move-into-group into the two routes, preserving order within
 * each route. An unknown id (no tab) is treated as normal.
 *
 * @param {number[]} tabIds
 * @param {(id: number) => ({pinned?: boolean} | null | undefined)} getTab
 * @returns {{groupPinTabIds: number[], normalTabIds: number[]}}
 */
export function partitionTabIdsForMove(tabIds, getTab) {
    const groupPinTabIds = [];
    const normalTabIds = [];

    for (const id of tabIds) {
        if (isPinnedNeedingGroupPin(getTab(id))) {
            groupPinTabIds.push(id);
        } else {
            normalTabIds.push(id);
        }
    }

    return {groupPinTabIds, normalTabIds};
}
