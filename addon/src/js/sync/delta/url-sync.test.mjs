/**
 * Standalone node test for the PURE URL classifiers (`url-sync.js`).
 *
 * Plain `node url-sync.test.mjs` (STG has no test runner). The module is pure (no
 * `browser.*` / `constants.js`), so it imports directly. Proves:
 *   - non-trivial about: URLs (about:debugging/config/…) ARE syncable, while the trivial
 *     new-tab/blank states (about:blank/newtab/home/privatebrowsing) are NOT;
 *   - everything the real-creation allow-list admits (http/moz-extension/view-source) stays
 *     syncable;
 *   - STG's "unsupported URL" stub page (moz-extension://…/help/stg-unsupported-url.html
 *     ?url=ORIG) decodes back to the embedded original — so a stub-rendered about: tab keeps
 *     its original identity and never diverges into a competing moz-extension tab record.
 *
 * Intentionally NOT matched by eslint (config targets addon/**\/*.js, not .mjs).
 */

import {
    isUrlSyncable,
    unwrapStubUrl,
    sanitizeFavIconUrl,
    MAX_SYNCABLE_FAVICON_LENGTH,
    liveUrlMatchesSource,
    shouldNavigateLiveTabUrl,
} from './url-sync.js';

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

const STUB = 'moz-extension://abcd-1234-uuid/help/stg-unsupported-url.html';

// --- isUrlSyncable: non-trivial about: URLs sync ----------------------------
{
    for (const url of ['about:debugging', 'about:config', 'about:addons', 'about:preferences']) {
        check(`syncable: ${url}`, isUrlSyncable(url) === true);
    }
}

// --- isUrlSyncable: trivial about: states do NOT sync -----------------------
{
    for (const url of ['about:blank', 'about:newtab', 'about:home', 'about:privatebrowsing']) {
        check(`NOT syncable: ${url}`, isUrlSyncable(url) === false);
    }
}

// --- isUrlSyncable: ordinary creatable URLs stay syncable -------------------
{
    check('syncable: http', isUrlSyncable('http://example.com/') === true);
    check('syncable: https', isUrlSyncable('https://example.com/') === true);
    check('syncable: moz-extension', isUrlSyncable('moz-extension://uuid/page.html') === true);
    check('syncable: view-source', isUrlSyncable('view-source:http://example.com/') === true);
}

// --- isUrlSyncable: junk / empty --------------------------------------------
{
    check('NOT syncable: empty string', isUrlSyncable('') === false);
    check('NOT syncable: null', isUrlSyncable(null) === false);
    check('NOT syncable: ftp', isUrlSyncable('ftp://example.com/') === false);
}

// --- unwrapStubUrl: stub decodes back to embedded original ------------------
{
    const stubbed = `${STUB}?url=${encodeURIComponent('about:debugging')}`;
    check('stub decodes back to about:debugging', unwrapStubUrl(stubbed) === 'about:debugging');

    const stubbedConfig = `${STUB}?url=${encodeURIComponent('about:config')}`;
    check('stub decodes back to about:config', unwrapStubUrl(stubbedConfig) === 'about:config');
}

// --- unwrapStubUrl: NO divergence — round trip identity ---------------------
{
    // the captured record of a stub-rendered tab must match the ORIGINAL about: uid url,
    // not the moz-extension stub url, so the two machines never diverge.
    const original = 'about:debugging';
    const stubbed = `${STUB}?url=${encodeURIComponent(original)}`;
    const recovered = unwrapStubUrl(stubbed);
    check('stub round-trip does not diverge', recovered === original);
    check('recovered url is itself syncable', isUrlSyncable(recovered) === true);
    check('recovered url is NOT the moz-extension stub', recovered !== stubbed);
}

// --- unwrapStubUrl: non-stub URLs pass through unchanged ---------------------
{
    check('plain http passes through', unwrapStubUrl('http://example.com/') === 'http://example.com/');
    check('about: passes through', unwrapStubUrl('about:debugging') === 'about:debugging');
    // a genuine non-stub moz-extension page (real STG page) must NOT be unwrapped.
    const realPage = 'moz-extension://uuid/manage/manage.html?x=1';
    check('non-stub moz-extension passes through', unwrapStubUrl(realPage) === realPage);
    // malformed / non-string input never throws.
    check('null passes through', unwrapStubUrl(null) === null);
}

// --- sanitizeFavIconUrl: KEEP favicons (incl. data:), only drop PATHOLOGICAL ----
{
    // Favicons are KEPT so every synced/sleeping tab shows an icon. A normal 16–32px PNG
    // data: favicon (~1–4 KB) is well under the ~50 KB cap and must pass through unchanged.
    const normalDataPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg' + 'A'.repeat(2000);
    check('normal data:image/png favicon KEPT', sanitizeFavIconUrl(normalDataPng) === normalDataPng);
    check('short data: favicon KEPT', sanitizeFavIconUrl('data:image/x,abc') === 'data:image/x,abc');

    // ONLY a pathologically large favicon (over the cap) is dropped — this is the bound that
    // keeps a stray multi-hundred-KB blob out of the snapshot/log.
    const hugeDataPng = 'data:image/png;base64,' + 'A'.repeat(MAX_SYNCABLE_FAVICON_LENGTH + 1);
    check('pathological data: favicon (> cap) dropped', sanitizeFavIconUrl(hugeDataPng) === undefined);
    const longUrl = 'https://example.com/' + 'x'.repeat(MAX_SYNCABLE_FAVICON_LENGTH);
    check('oversized favicon url (> cap) dropped', sanitizeFavIconUrl(longUrl) === undefined);

    // a favicon EXACTLY at the cap is still kept (boundary: only > cap is dropped).
    const atCap = 'x'.repeat(MAX_SYNCABLE_FAVICON_LENGTH);
    check('favicon at exactly the cap KEPT', sanitizeFavIconUrl(atCap) === atCap);

    // normal remote favicon urls pass through unchanged.
    check('http favicon preserved', sanitizeFavIconUrl('http://e/favicon.ico') === 'http://e/favicon.ico');
    check('https favicon preserved', sanitizeFavIconUrl('https://e.com/static/icon.png') === 'https://e.com/static/icon.png');

    // empty / missing favicon → undefined (omitted).
    check('empty favicon dropped', sanitizeFavIconUrl('') === undefined);
    check('null favicon dropped', sanitizeFavIconUrl(null) === undefined);
    check('undefined favicon dropped', sanitizeFavIconUrl(undefined) === undefined);

    // idempotent: a kept value stays kept; a clean one stays clean.
    check('sanitize idempotent on clean url',
        sanitizeFavIconUrl(sanitizeFavIconUrl('https://e/i.ico')) === 'https://e/i.ico');
    check('sanitize idempotent on kept data: favicon',
        sanitizeFavIconUrl(sanitizeFavIconUrl(normalDataPng)) === normalDataPng);
}

// ---------------------------------------------------------------------------
// liveUrlMatchesSource — STUB-AWARE uid-stamp match (apply side).
// ---------------------------------------------------------------------------
{
    const stub = url => {
        const u = new URL('moz-extension://uuid/help/stg-unsupported-url.html');
        u.searchParams.set('url', url);
        return u.href;
    };
    check('match: identical http urls', liveUrlMatchesSource('http://a', 'http://a') === true);
    check('match: stub-rendered about: tab matches about: source',
        liveUrlMatchesSource(stub('about:config'), 'about:config') === true);
    check('match: real moz-extension url matches itself',
        liveUrlMatchesSource('moz-extension://uuid/options/options.html', 'moz-extension://uuid/options/options.html') === true);
    check('no match: different urls', liveUrlMatchesSource('http://a', 'http://b') === false);
    check('no match: about:blank live vs http source (mid-load) ⇒ caller falls back to index',
        liveUrlMatchesSource('about:blank', 'http://a') === false);
}

// ---------------------------------------------------------------------------
// shouldNavigateLiveTabUrl — NO-OP convergence guard (apply side).
// ---------------------------------------------------------------------------
{
    const stub = url => {
        const u = new URL('moz-extension://uuid/help/stg-unsupported-url.html');
        u.searchParams.set('url', url);
        return u.href;
    };
    check('navigate when live differs from target', shouldNavigateLiveTabUrl('http://old', 'http://new') === true);
    check('NO-OP when live already equals target', shouldNavigateLiveTabUrl('http://x', 'http://x') === false);
    check('NO-OP when stub-rendered about: tab already at target (stub-decoded)',
        shouldNavigateLiveTabUrl(stub('about:debugging'), 'about:debugging') === false);
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    process.exit(1);
}
