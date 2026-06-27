/**
 * Pure helper for the capture layer's GROUP-RELATIVE index computation.
 *
 * Import-free (no extension-host dependencies) so it can be unit-tested with `node`
 * directly, like {@link module:tab-move-split}. The live wrapper in
 * {@link module:sync/delta/delta-capture} feeds it `browser.tabs.query` results plus a
 * `Cache.getTabGroup` resolver.
 *
 * @module sync/delta/group-relative-index
 */

/**
 * Compute a tab's 0-based position among the tabs of the SAME group within the same
 * window, ordered by browser index.
 *
 * The delta/replay model treats a tab's `index` as the position WITHIN its group's
 * ordered tab list (0..n-1), NOT the browser-window-absolute `tab.index` (which is
 * shifted by pinned tabs and other groups' tabs sharing the window, and differs per
 * machine). Replaying by the absolute index shuffles the group's order on every other
 * device, so capture derives the within-group position instead.
 *
 * Returns null (⇒ caller omits `index` ⇒ replay appends at end) when the position can't
 * be determined — better an append than a wrong slot.
 *
 * @param {Array<{id:number, index:number}>} windowTabs - the window's live tabs.
 * @param {(tabId:number)=>(string|undefined)} getTabGroupFn - resolves a tab's groupId.
 * @param {number} tabId - the tab whose position we want.
 * @param {string} groupId - the group to scope the position to.
 * @returns {number|null}
 */
export function computeGroupRelativeIndex(windowTabs, getTabGroupFn, tabId, groupId) {
    if (!Array.isArray(windowTabs) || typeof getTabGroupFn !== 'function' || !groupId) {
        return null;
    }

    const groupTabs = windowTabs
        .filter(t => getTabGroupFn(t.id) === groupId)
        .sort((a, b) => a.index - b.index);

    const position = groupTabs.findIndex(t => t.id === tabId);
    return position === -1 ? null : position;
}
