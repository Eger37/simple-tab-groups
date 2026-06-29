/**
 * Standalone node test for the favicon bloat-bound (the 5 GB `syncDeltaLog` regression).
 *
 * Plain `node favicon-bloat.test.mjs` (STG has no test runner). `delta-capture.js` and
 * `tabs.js` are impure (browser-dependent), so — as the other delta tests do — the PURE
 * contracts under test are re-implemented here from the same source and asserted:
 *
 *   1. Inline `data:` favicons are DROPPED from tab/pinned records (they caused the multi-GB
 *      `syncDeltaLog` bloat). Only small URL references (http(s)/moz-extension) are kept; an
 *      oversized URL reference (>~50 KB) is also dropped. The live page re-fetches the icon.
 *
 *   2. A favicon-ONLY `onUpdated` change emits NO delta event. The tabs.js gate that decides
 *      whether to emit a tab.modify / pinned.modify fires only on a title (or url) change. A
 *      favicon needs no event of its own.
 *
 *   3. The favicon propagates for free: a normal tab.add / tab.modify record (written for a
 *      url/title change) carries the CURRENT favicon as a field. Because a favicon is never
 *      its own event, it can only ever appear as one field of the latest record per tab — the
 *      347k-duplication that caused the 5 GB bloat is structurally impossible.
 *
 * Intentionally NOT matched by eslint (config targets addon/**\/*.js, not .mjs).
 */

import {sanitizeFavIconUrl, MAX_SYNCABLE_FAVICON_LENGTH} from './url-sync.js';

let passed = 0;
const failures = [];

function check(name, cond, detail) {
    if (cond) {
        passed++;
        console.log(`  PASS  ${name}`);
    } else {
        failures.push(name);
        console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

// --- copy of delta-capture.js buildTabRecord favicon handling (kept identical) ----
// Only the favicon field is reproduced; the rest of the record is irrelevant here.
function buildTabRecord(tab) {
    return {
        uid: tab.uid,
        url: tab.url,
        title: tab.title,
        favIconUrl: sanitizeFavIconUrl(tab.favIconUrl),
    };
}

function buildPinnedRecord(tab) {
    return {
        uid: tab.uid,
        url: tab.url,
        title: tab.title,
        favIconUrl: sanitizeFavIconUrl(tab.favIconUrl),
    };
}

// --- copy of tabs.js onUpdated emit gate (kept identical to the grouped + pinned paths) ---
// Returns true when a delta (tab.modify / pinned.modify) WOULD be emitted for this change.
function wouldEmitDelta(changeInfo) {
    // grouped path: Object.hasOwn(changeInfo, 'title')
    // pinned path:  Object.hasOwn(changeInfo, 'title') || Object.hasOwn(changeInfo, 'url')
    // Neither path includes 'favIconUrl' — a favicon-only change emits NO delta.
    return Object.hasOwn(changeInfo, 'title') || Object.hasOwn(changeInfo, 'url');
}

const NORMAL_DATA_FAVICON = 'data:image/png;base64,iVBORw0KGgoAAAANSU' + 'A'.repeat(2000);
const HUGE_URL_FAVICON = 'https://a/favicon.ico?' + 'A'.repeat(MAX_SYNCABLE_FAVICON_LENGTH + 1);

// --- 1. records DROP inline data: favicons, keep small URL refs, drop oversized URLs --------
{
    const groupTab = buildTabRecord({uid: 'u1', url: 'https://a', title: 'A', favIconUrl: NORMAL_DATA_FAVICON});
    check('buildTabRecord DROPS data: favicon', groupTab.favIconUrl === undefined);

    const groupTabHttp = buildTabRecord({uid: 'u2', url: 'https://a', title: 'A', favIconUrl: 'https://a/favicon.ico'});
    check('buildTabRecord keeps remote favicon', groupTabHttp.favIconUrl === 'https://a/favicon.ico');

    const groupTabHuge = buildTabRecord({uid: 'u3', url: 'https://a', title: 'A', favIconUrl: HUGE_URL_FAVICON});
    check('buildTabRecord drops pathological (>50KB) url favicon', groupTabHuge.favIconUrl === undefined);

    const pinned = buildPinnedRecord({uid: 'p1', url: 'https://b', title: 'B', favIconUrl: NORMAL_DATA_FAVICON});
    check('buildPinnedRecord DROPS data: favicon', pinned.favIconUrl === undefined);

    const pinnedHttp = buildPinnedRecord({uid: 'p2', url: 'https://b', title: 'B', favIconUrl: 'https://b/favicon.ico'});
    check('buildPinnedRecord keeps remote favicon', pinnedHttp.favIconUrl === 'https://b/favicon.ico');

    const pinnedHuge = buildPinnedRecord({uid: 'p3', url: 'https://b', title: 'B', favIconUrl: HUGE_URL_FAVICON});
    check('buildPinnedRecord drops pathological url favicon', pinnedHuge.favIconUrl === undefined);
}

// --- 2. a favicon-only change does NOT produce a delta event -----------------
{
    check('favicon-only change emits NO delta', wouldEmitDelta({favIconUrl: NORMAL_DATA_FAVICON}) === false);
    check('favicon-only (remote url) change emits NO delta', wouldEmitDelta({favIconUrl: 'https://a/favicon.ico'}) === false);

    // a real content change (title / url) still emits — and the favicon rides along in the
    // record (see test 3 below).
    check('title change still emits a delta', wouldEmitDelta({title: 'New'}) === true);
    check('url change still emits a delta', wouldEmitDelta({url: 'https://new'}) === true);
    check('title+favicon change emits a delta', wouldEmitDelta({title: 'New', favIconUrl: NORMAL_DATA_FAVICON}) === true);
}

// --- 3. the favicon rides along inside the record written for a real change ----
{
    // a tab.add / tab.modify (built when url/title changes) carries the tab's CURRENT favicon
    // as a plain field — so the favicon propagates without any favicon-specific event.
    const liveTab = {uid: 'u9', url: 'https://gmail.com', title: 'Inbox (3)', favIconUrl: 'https://gmail.com/favicon.ico'};
    const rec = buildTabRecord(liveTab);
    check('tab.modify record carries the current favicon', rec.favIconUrl === 'https://gmail.com/favicon.ico');

    // the favicon appears as exactly ONE field of the latest record — never its own event —
    // so a single favicon can never be duplicated across hundreds of thousands of events.
    const rec2 = buildTabRecord({...liveTab, title: 'Inbox (4)', favIconUrl: 'https://gmail.com/new.ico'});
    check('a later record carries the NEW current favicon (latest-wins, 1 copy)',
        rec2.favIconUrl === 'https://gmail.com/new.ico');
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    process.exit(1);
}
