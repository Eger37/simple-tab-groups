/**
 * Standalone node test for the pure move-into-group pinned/normal split helpers.
 *
 * Like the other delta tests, this is a plain `node tab-move-split.test.mjs` script (STG
 * has no test runner). It imports the pure module directly (no extension host) and asserts
 * the routing decision that EVERY move-into-group caller (native menu, hotkey, popup/Manage
 * drag + context menu, and the moveTabs mixin) relies on. Exits non-zero on the first
 * failure. Lives here so the existing `node src/js/sync/delta/*.test.mjs` run picks it up.
 */

import {isPinnedNeedingGroupPin, partitionTabIdsForMove} from '../../tab-move-split.js';

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

// ---------------------------------------------------------------------------
// isPinnedNeedingGroupPin: any browser-pinned tab routes through the group-pin flow on a
// move into a group (it can't be hidden). Unpinned tabs go the normal move path.
// ---------------------------------------------------------------------------
check('global pinned tab (no group) → group-pin route',
    isPinnedNeedingGroupPin({pinned: true}) === true);

check('global pinned tab with groupPinned:false → group-pin route',
    isPinnedNeedingGroupPin({pinned: true, groupPinned: false}) === true);

check('already group-pinned tab (pinned) → group-pin route (re-target, never dropped)',
    isPinnedNeedingGroupPin({pinned: true, groupPinned: true}) === true);

check('normal unpinned tab → NOT routed',
    isPinnedNeedingGroupPin({pinned: false}) === false);

check('unpinned tab with stray groupPinned flag → NOT routed (not pinned)',
    isPinnedNeedingGroupPin({pinned: false, groupPinned: true}) === false);

check('tab with no pinned field → NOT routed',
    isPinnedNeedingGroupPin({}) === false);

check('undefined tab → NOT routed (safe)',
    isPinnedNeedingGroupPin(undefined) === false);

check('null tab → NOT routed (safe)',
    isPinnedNeedingGroupPin(null) === false);

check('truthy-but-non-boolean pinned does NOT count (strict === true)',
    isPinnedNeedingGroupPin({pinned: 1}) === false);

// ---------------------------------------------------------------------------
// partitionTabIdsForMove: split a mixed selection (multi-select) into the two routes,
// preserving order within each route. Unknown ids resolve as normal.
// ---------------------------------------------------------------------------
{
    const tabs = {
        1: {pinned: true},                       // global pinned → group-pin
        2: {pinned: false},                      // normal
        3: {pinned: true, groupPinned: true},    // already group-pinned → group-pin (re-target)
        4: {pinned: true, groupPinned: false},   // global pinned → group-pin
        5: undefined,                            // unknown → normal
    };
    const {groupPinTabIds, normalTabIds} = partitionTabIdsForMove(
        [1, 2, 3, 4, 5],
        id => tabs[id],
    );

    check('partition: group-pin ids in order (all pinned, incl. already group-pinned)',
        JSON.stringify(groupPinTabIds) === JSON.stringify([1, 3, 4]),
        JSON.stringify(groupPinTabIds));

    check('partition: normal ids in order (unpinned + unknown)',
        JSON.stringify(normalTabIds) === JSON.stringify([2, 5]),
        JSON.stringify(normalTabIds));

    check('partition: every input id is accounted for exactly once',
        groupPinTabIds.length + normalTabIds.length === 5);
}

{
    const {groupPinTabIds, normalTabIds} = partitionTabIdsForMove([], () => undefined);
    check('partition: empty selection → both routes empty',
        groupPinTabIds.length === 0 && normalTabIds.length === 0);
}

// ---------------------------------------------------------------------------

if (failures.length) {
    console.error(`\n${failures.length} failed, ${passed} passed`);
    console.error('FAILURES:', failures);
    process.exit(1);
} else {
    console.log(`\n${passed} passed, 0 failed`);
}
