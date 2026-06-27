/**
 * Pure decision for the sync-applied navigation ECHO guard (see {@link module:sync/delta/delta-capture}).
 *
 * The transport's content-update path navigates a live tab via `browser.tabs.update({url})`,
 * which resolves as soon as the navigation STARTS; the resulting `onUpdated` (and any server
 * redirect it triggers) fires ASYNCHRONOUSLY, AFTER the apply's `endApply()` has run. Without a
 * guard that delayed echo is re-captured as a fresh `tab.modify`/`pinned.modify` and pushed next
 * cycle — and on a redirect the captured live url never equals the cloud url, so the planner
 * re-emits the update EVERY cycle (perpetual churn). This module holds the import-free decision
 * for "is this content change a sync-applied echo (suppress) or a genuine user navigation (sync)?"
 * so the echo-vs-user-nav seam is unit-testable without the browser/cache dependencies of the
 * capture layer.
 *
 * @module sync/delta/applied-nav-echo
 */

/**
 * Is a content change a sync-APPLIED navigation echo that must be suppressed (vs a genuine user
 * navigation — or a server REDIRECT — that must sync)?
 *
 *  - TRUE while a sync apply is in progress (`applying`): the in-apply synchronous suppression.
 *    Every change landing during the apply is the transport's own write, so it is always an echo.
 *  - When the tab carries a live applied-navigation mark (`now < markExpiry`), the decision is
 *    NARROWED BY URL — this is the convergence fix for "loads infinitely":
 *      · if the observed url EQUALS the url the apply navigated this tab to (`markUrl`), it is the
 *        plain settle echo of exactly what we applied ⇒ SUPPRESS (don't re-capture our own write);
 *      · if the observed url DIFFERS from `markUrl`, the page server-REDIRECTED (applied X → landed
 *        on Y). That Y is genuinely new information the cloud does not have: it MUST be captured and
 *        pushed so the cloud converges to Y (after which live==cloud and the planner stops
 *        re-emitting the update). So a redirect to a DIFFERENT url is NOT an echo ⇒ CAPTURE.
 *      · when `markUrl` is unknown (legacy mark without a url, or no observed url to compare), fall
 *        back to the old window-based suppression (suppress while the mark is live) — safe default.
 *  - FALSE otherwise — including an EXPIRED mark (`now >= markExpiry`) — so a user navigation made
 *    outside the apply's tight causal window syncs normally (preserves A6 user-nav capture).
 *
 * @param {object} args
 * @param {boolean} args.applying - is a sync apply in progress right now.
 * @param {number} [args.markExpiry] - this tab's applied-navigation mark expiry (epoch ms), or undefined.
 * @param {string} [args.markUrl] - the EXACT url the apply navigated this tab to (the url whose echo
 *   must be suppressed). Undefined for a legacy/url-less mark.
 * @param {string} [args.observedUrl] - the url of the content change being classified right now.
 * @param {number} args.now - current epoch ms.
 * @returns {boolean} true ⇒ suppress (echo); false ⇒ capture (user navigation / redirect).
 */
export function isAppliedNavigationEcho({applying, markExpiry, markUrl, observedUrl, now}) {
    if (applying) {
        return true;
    }
    if (!Number.isFinite(markExpiry) || now >= markExpiry) {
        return false; // no live mark ⇒ not an echo (user nav outside the causal window syncs).
    }
    // Live mark. Narrow by url: suppress ONLY the echo of the exact applied url; let a redirect
    // to a DIFFERENT url through so the cloud can converge to the redirect target.
    if (typeof markUrl === 'string' && typeof observedUrl === 'string') {
        return observedUrl === markUrl;
    }
    // url-less mark / no observed url to compare ⇒ window-based suppression (legacy-safe default).
    return true;
}
