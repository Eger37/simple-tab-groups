/**
 * Standalone node test for the delta-log FIRST-HYDRATION RACE fix (E1, data loss).
 *
 * Plain `node delta-log-hydration.test.mjs` (STG has no test runner). Unlike the sibling
 * delta tests, the contract under test lives INSIDE the impure `delta-log.js`
 * (`ensureLoaded()`'s lazy hydration + seq machinery), so re-implementing it would not test
 * the fix. Instead we load the REAL module and stub only its browser-dependent imports via
 * `delta-log-hydration.loader.mjs` (registered below) plus a controllable mock of
 * `browser.storage.local`.
 *
 * The bug: `ensureLoaded()`'s only guard was `if (events !== null) return`, but `events` is
 * assigned AFTER `await browser.storage.local.get(...)`. Two concurrent first-touch callers
 * both saw `events === null`, both awaited the get, and the second OVERWROTE `events` with a
 * fresh stored array — dropping the event the first had already appended and recomputing
 * `lastSeq` from storage, so the next append reused a collided seq.
 *
 * The fix memoizes the hydration as a single in-flight promise so all first-touch callers
 * await ONE get + migration. This test drives two operations that BOTH start before the
 * hydration's get resolves, then asserts: no event lost, seq strictly monotonic (no
 * collision), and exactly one underlying get was issued (proof of memoization). It also
 * checks the reset path (clear() lets a later hydration re-run) and that the favicon
 * migration still runs exactly once.
 *
 * Intentionally NOT matched by eslint (config targets addon/**\/*.js, not .mjs); it uses
 * node globals (process, console, module.register) the browser config bans.
 */

import {register} from 'node:module';

// redirect delta-log.js's browser-impure imports to tiny virtual stubs (worker-thread hook).
register(new URL('./delta-log-hydration.loader.mjs', import.meta.url));

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

/**
 * Controllable mock of `browser.storage.local`.
 *
 * `get` returns a promise that ONLY resolves when the test calls `releaseGets()`, so two
 * concurrent first-touch callers can both be parked mid-hydration — exactly the window the
 * old guard left open. `getCallCount` proves how many gets the module actually issued.
 */
function makeMockStorage(initial = {}) {
    const store = {...initial};
    let pendingGetResolvers = [];
    const mock = {
        getCallCount: 0,
        setCallCount: 0,
        async get(key) {
            mock.getCallCount++;
            // Snapshot the store AT CALL TIME (faithful to a real async get: the read is taken
            // when issued, not when it resolves). This is what makes the buggy first-hydration
            // race observable — a 2nd get issued before the 1st caller's append persists sees
            // the OLD (e1-less) store and overwrites `events`, dropping e1.
            const value = store[key];
            const snapshot = value === undefined ? {} : {[key]: structuredClone(value)};
            // park until released.
            await new Promise(resolve => pendingGetResolvers.push(resolve));
            return snapshot;
        },
        async set(obj) {
            mock.setCallCount++;
            Object.assign(store, structuredClone(obj));
        },
        releaseGets() {
            const resolvers = pendingGetResolvers;
            pendingGetResolvers = [];
            resolvers.forEach(r => r());
        },
        // release the gets ONE AT A TIME, each followed by a full drain of the microtask
        // queue, so the first caller's whole hydrate+append settles BEFORE the next get
        // resolves. On the buggy code this forces the lossy ordering (the 2nd get overwrites
        // `events` after the 1st already appended); on the fixed code there is only ever one
        // get, so the rest are no-ops.
        async releaseGetsSequentially() {
            while (pendingGetResolvers.length) {
                const next = pendingGetResolvers.shift();
                next();
                // let the freed caller run to completion (hydrate body, append, persist).
                for (let i = 0; i < 50; i++) {
                    await Promise.resolve();
                }
            }
        },
        pendingGetCount() {
            return pendingGetResolvers.length;
        },
        rawStore() {
            return store;
        },
    };
    return mock;
}

/** Install a fresh mock + a freshly-imported delta-log module (module state is per-import). */
async function freshLog(initial = {}) {
    const mock = makeMockStorage(initial);
    globalThis.browser = {storage: {local: mock}};
    // cache-bust the import so each test gets pristine module-level `events`/`loadingPromise`.
    const mod = await import(`./delta-log.js?fresh=${Math.random()}`);
    return {mock, mod};
}

// --- 1. THE RACE: two concurrent first-touch ops, both parked mid-hydration -------
{
    const {mock, mod} = await freshLog();

    // both calls enter ensureLoaded() before any get resolves.
    const p1 = mod.append(mod.OPS.GROUP_ADD, {group: {id: 1, title: 'g1'}});
    const p2 = mod.append(mod.OPS.GROUP_ADD, {group: {id: 2, title: 'g2'}});

    // let microtasks run so both callers have reached the awaited get.
    await Promise.resolve();
    await Promise.resolve();

    check('memoized hydration issues exactly ONE storage.get for concurrent first-touch',
        mock.getCallCount === 1, `got ${mock.getCallCount}`);

    // release sequentially to FORCE the lossy ordering on buggy code (2nd get's overwrite
    // lands after the 1st caller's append); a no-op past the first get on fixed code.
    await mock.releaseGetsSequentially();
    const [e1, e2] = await Promise.all([p1, p2]);

    const all = await mod.getEvents();
    check('no event lost under the first-hydration race', all.length === 2,
        `expected 2 events, got ${all.length}`);

    const seqs = all.map(e => e.seq).sort((a, b) => a - b);
    check('no seq collision (seqs are distinct)', new Set(seqs).size === seqs.length,
        `seqs=${JSON.stringify(seqs)}`);
    check('seq is strictly monotonic from 1', seqs[0] === 1 && seqs[1] === 2,
        `seqs=${JSON.stringify(seqs)}`);
    check('both appends returned distinct events with their own seq',
        e1 && e2 && e1.seq !== e2.seq, `e1=${e1?.seq} e2=${e2?.seq}`);

    // a follow-up append continues monotonically — proves lastSeq was not rewound.
    const e3 = await mod.append(mod.OPS.GROUP_ADD, {group: {id: 3, title: 'g3'}});
    check('next append continues monotonically (lastSeq not rewound)', e3.seq === 3,
        `e3.seq=${e3.seq}`);
}

// --- 2. concurrent append + getEvents (capture racing the transport) --------------
{
    const {mock, mod} = await freshLog();

    const pAppend = mod.append(mod.OPS.TAB_ADD, {groupId: 1, tab: {uid: 't1', url: 'https://a', title: 'A'}});
    const pRead = mod.getEvents();

    await Promise.resolve();
    await Promise.resolve();
    check('append racing getEvents still issues ONE get', mock.getCallCount === 1,
        `got ${mock.getCallCount}`);

    mock.releaseGets();
    await Promise.all([pAppend, pRead]);

    const all = await mod.getEvents();
    check('append survives a concurrent first-touch getEvents', all.length === 1 && all[0].seq === 1,
        `events=${JSON.stringify(all.map(e => e.seq))}`);
}

// --- 3. hydration reads an EXISTING persisted log without losing the new append ----
{
    const existing = {
        syncDeltaLog: {
            v: 1,
            deviceId: 'test-device',
            events: [
                {seq: 1, ts: 1, op: 'group.add', group: {id: 1, title: 'g1'}},
                {seq: 2, ts: 2, op: 'group.add', group: {id: 2, title: 'g2'}},
            ],
        },
    };
    const {mock, mod} = await freshLog(existing);

    const p1 = mod.append(mod.OPS.GROUP_ADD, {group: {id: 3, title: 'g3'}});
    const p2 = mod.getLastSeq();
    await Promise.resolve();
    await Promise.resolve();
    mock.releaseGets();
    const [appended] = await Promise.all([p1, p2]);

    const all = await mod.getEvents();
    check('appends after hydrating a non-empty log keep all prior events', all.length === 3,
        `len=${all.length}`);
    check('new event seq follows the persisted max (no collision with stored seqs)',
        appended.seq === 3, `seq=${appended.seq}`);
    check('only one get for the concurrent first touch on a non-empty log',
        mock.getCallCount === 1, `got ${mock.getCallCount}`);
}

// --- 4. favicon migration still runs exactly once on hydrate ----------------------
{
    const withFavicons = {
        syncDeltaLog: {
            v: 1,
            deviceId: 'test-device',
            events: [
                {seq: 1, ts: 1, op: 'tab.add', groupId: 1, tab: {uid: 't1', url: 'https://a', title: 'A', favIconUrl: 'data:image/png;base64,AAAA'}},
                {seq: 2, ts: 2, op: 'tab.modify', groupId: 1, tab: {uid: 't1', url: 'https://a', title: 'B', favIconUrl: 'https://a/favicon.ico'}},
            ],
        },
    };
    const {mock, mod} = await freshLog(withFavicons);

    // two concurrent first-touch reads — migration must run once, not twice.
    const p1 = mod.getEvents();
    const p2 = mod.getEvents();
    await Promise.resolve();
    await Promise.resolve();
    mock.releaseGets();
    const [a] = await Promise.all([p1, p2]);

    check('migration strips favicons from all stored events', a.every(e => !Object.hasOwn(e.tab ?? {}, 'favIconUrl')),
        JSON.stringify(a));
    // migration rewrites the log exactly once (one set for the migration). A second get-touch
    // must not re-run the body, so no extra set beyond the single migration write.
    check('migration rewrites the log exactly once (single set)', mock.setCallCount === 1,
        `setCallCount=${mock.setCallCount}`);
    check('a single get serves both concurrent first-touch reads', mock.getCallCount === 1,
        `getCallCount=${mock.getCallCount}`);

    // a second touch after hydration completes must not re-hydrate (no extra get).
    await mod.getEvents();
    check('post-hydration read does not re-issue a get', mock.getCallCount === 1,
        `getCallCount=${mock.getCallCount}`);
}

// --- 5. reset path: clear() lets a LATER hydration re-run cleanly ------------------
{
    const {mock, mod} = await freshLog();

    const p = mod.append(mod.OPS.GROUP_ADD, {group: {id: 1, title: 'g1'}});
    await Promise.resolve();
    mock.releaseGets();
    await p;
    check('pre-clear: one get so far', mock.getCallCount === 1, `got ${mock.getCallCount}`);

    await mod.clear();
    const getsAfterClear = mock.getCallCount;
    check('clear() reuses the already-resolved hydration (no extra get during clear)',
        getsAfterClear === 1, `got ${getsAfterClear}`);

    // clear() dropped the memoized promise, so the NEXT first touch re-runs hydration cleanly
    // (re-issues a get) rather than being short-circuited by the stale resolved promise.
    // clear() persisted the empty log, so the re-hydration reads back an empty log.
    const pRead = mod.getEvents();
    await Promise.resolve();
    await Promise.resolve();
    check('clear() dropped the memoized promise → a later first touch re-hydrates',
        mock.getCallCount === getsAfterClear + 1, `got ${mock.getCallCount}`);
    mock.releaseGets();
    check('clear() resets the log to empty', (await pRead).length === 0);
    check('clear() resets lastSeq to 0', (await mod.getLastSeq()) === 0);

    // append continues from a fresh seq 1 (hard reset semantics).
    const e = await mod.append(mod.OPS.GROUP_ADD, {group: {id: 9, title: 'g9'}});
    check('post-clear append restarts at seq 1', e.seq === 1, `seq=${e.seq}`);
}

// --- 6. a FAILED hydration is not cached forever — a later call retries -----------
{
    const mock = makeMockStorage();
    let failNext = true;
    const realGet = mock.get.bind(mock);
    mock.get = async key => {
        if (failNext) {
            failNext = false;
            mock.getCallCount++;
            throw new Error('storage unavailable');
        }
        return realGet(key);
    };
    globalThis.browser = {storage: {local: mock}};
    const mod = await import(`./delta-log.js?fresh=${Math.random()}`);

    let threw = false;
    try {
        await mod.getLastSeq();
    } catch {
        threw = true;
    }
    check('a failed hydration surfaces the error', threw === true);

    // a later call must RETRY (not replay the cached rejection).
    const p = mod.append(mod.OPS.GROUP_ADD, {group: {id: 1, title: 'g1'}});
    await Promise.resolve();
    await Promise.resolve();
    mock.releaseGets();
    const e = await p;
    check('a later first touch retries after a failed hydration', e?.seq === 1, `e=${JSON.stringify(e)}`);
}

// --- 7. appendMany: one persist for a batch, sequential seqs ----------------------
{
    const {mock, mod} = await freshLog();

    const batch = [
        {op: mod.OPS.GROUP_ADD, group: {id: 1, title: 'g1'}},
        {op: 'bogus.op', group: {id: 99, title: 'skip'}},
        {op: mod.OPS.TAB_ADD, groupId: 1, tab: {uid: 'x', url: 'https://a', title: 'A'}},
        {op: mod.OPS.GROUP_ADD, group: {id: 2, title: 'g2'}},
    ];
    const validCount = 3;

    const p = mod.appendMany(batch);
    await Promise.resolve();
    await Promise.resolve();
    mock.releaseGets();
    const appended = await p;

    check('appendMany skips invalid ops but keeps the valid ones',
        appended.length === validCount, `len=${appended.length}`);
    check('appendMany persists the whole batch in ONE set', mock.setCallCount === 1,
        `setCallCount=${mock.setCallCount}`);

    const batchSeqs = appended.map(e => e.seq);
    check('appendMany assigns sequential seqs from 1 with no gaps',
        batchSeqs.every((s, i) => s === i + 1), `seqs=${JSON.stringify(batchSeqs)}`);
    check('appendMany preserves each item op', appended[0].op === mod.OPS.GROUP_ADD
        && appended[1].op === mod.OPS.TAB_ADD && appended[2].op === mod.OPS.GROUP_ADD,
        JSON.stringify(appended.map(e => e.op)));

    const all = await mod.getEvents();
    check('appendMany stored exactly the valid events', all.length === validCount,
        `len=${all.length}`);

    const e = await mod.append(mod.OPS.GROUP_ADD, {group: {id: 3, title: 'g3'}});
    check('a single append after appendMany continues monotonically',
        e.seq === validCount + 1, `seq=${e.seq}`);
}

// --- 8. appendMany([]) is a no-op: no persist ------------------------------------
{
    const {mock, mod} = await freshLog();

    const pRead = mod.getEvents();
    await Promise.resolve();
    await Promise.resolve();
    mock.releaseGets();
    await pRead;

    check('appendMany on an empty store issues no set during hydration',
        mock.setCallCount === 0, `setCallCount=${mock.setCallCount}`);

    const result = await mod.appendMany([]);
    check('appendMany([]) returns an empty array', Array.isArray(result) && result.length === 0,
        JSON.stringify(result));
    check('appendMany([]) issues no set', mock.setCallCount === 0,
        `setCallCount=${mock.setCallCount}`);
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    process.exit(1);
}
