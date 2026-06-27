
/**
 * Pure replay / merge engine for hybrid snapshot + delta sync (Phase P2).
 *
 * Given a compacted base snapshot and a set of per-device delta logs, this module
 * computes the effective state by replaying every event in a deterministic global
 * order and resolving conflicts per the rules in `.project/DESIGN_DELTA_SYNC.md`
 * ("Replay / conflict rules"). It is the heart of the reliability story: no event is
 * ever silently dropped, and concurrent edits degrade to a duplicate rather than to
 * lost work.
 *
 * ## Purity (hard requirement)
 * This module is PURE: it touches no `browser.*` API, no DOM, and imports nothing
 * that performs side effects at evaluation time (in particular NOT `constants.js`,
 * which fetches at module load). It clones its inputs and never mutates them. This
 * lets the engine — and its conflict rules, the riskiest part of sync — run and be
 * tested under plain `node` with no extension host. Any constant it needs (e.g. the
 * default `cookieStoreId`) is a local literal or a parameter.
 *
 * Later phases consume this: P3 (transport) pulls the snapshot + delta files, calls
 * {@link replay}, diffs the resolved snapshot against the live browser and applies it
 * via existing STG apply logic; P4 (compaction) folds events into a new base using
 * THIS SAME function, guaranteeing the compacted base equals the replayed state.
 *
 * ## Snapshot shape
 *   {
 *     groups: [ { id, title, ...props, tabs: [ { uid, url, title, cookieStoreId?, index?, ... } ] } ],
 *     pinnedTabs?: [ { uid, url, title, cookieStoreId?, index?, ... } ],  // global pinned, missing ⇒ []
 *     options?: { [key]: value }                  // resolved synced global settings; missing ⇒ {}
 *     containers?: { [portableKey]: {name, color, icon} }  // portable container registry; missing ⇒ {}
 *     watermark?: { [deviceId]: lastFoldedSeq }   // missing ⇒ {}
 *   }
 *
 * All `cookieStoreId` values in tab/group/pinned/`defaultGroupProps` records are PORTABLE
 * KEYS (a container's `name+color+icon` identity, or a reserved default/temporary marker),
 * never a raw per-install `cookieStoreId`. The `containers` registry maps each portable key
 * to the `{name, color, icon}` the receiving device needs to find-or-create the matching
 * local container. Translation local⟷portable happens ONLY at the impure boundary in
 * `delta-sync.js` (see `container-map.js`); replay is portable-key-agnostic and just carries
 * the registry through untouched (it is the same on every device for a given identity).
 *
 * `pinnedTabs` is a single ordered array of the window-global pinned tabs (they belong
 * to no STG group; this mirrors the legacy backup field `data.pinnedTabs`). Pinned
 * events (`pinned.*`) fold into it under the SAME conflict rules as group tabs:
 * modify-beats-delete resurrects, watermark dedups, identity is `uid`.
 *
 * ## Delta log shape (per P1 `delta-log.js`)
 *   { deviceId, events: [ { seq, ts, op, ...payload } ] }
 * Payloads by op:
 *   tab.add      { groupId, tab: <full tab record incl. uid> }
 *   tab.modify   { groupId, tab: <full tab record incl. uid> }
 *   tab.move     { groupId, uid, toIndex }
 *   tab.remove   { groupId, uid }
 *   group.add    { group: <full group record incl. id> }
 *   group.modify { group: <full or partial group record incl. id> }
 *   group.remove { groupId }
 *   option.set   { key, value }
 *   pinned.add    { tab: <full pinned tab record incl. uid> }
 *   pinned.modify { tab: <full pinned tab record incl. uid> }
 *   pinned.move   { uid, toIndex }
 *   pinned.remove { uid }
 *
 * ## Global options resolution (per-key last-writer-wins)
 * `option.set` events fold into `snapshot.options` — a flat `{key: value}` bag of the
 * synced global STG settings. Resolution is per-key LAST-WRITER-WINS by the winning
 * event's `ts`: as events are applied in global order (ts asc, tie-break deviceId then
 * seq), a later-or-equal `ts` for a key overrides the value held for it. Because the
 * global order is already total and deterministic, "process in order, later overrides"
 * is exactly LWW with the (deviceId, seq) tie-break — we don't track a separate per-key
 * ts since the apply order encodes it. Which keys are eligible is decided UPSTREAM (the
 * capture layer only emits `option.set` for synced keys); replay folds whatever arrives.
 *
 * @module sync/delta/replay
 */

/**
 * Default container used when a recreated tab carries no `cookieStoreId`. Mirrors
 * `Constants.DEFAULT_COOKIE_STORE_ID_FIREFOX` but is a local literal so this module
 * stays import-free / pure (see module docs). It is only a cosmetic default for a
 * resurrected tab record; the merge logic itself never depends on it.
 */
const DEFAULT_COOKIE_STORE_ID = 'firefox-default';

/**
 * Matches a canonical UUID (e.g. the `randomUUID()` group ids STG mints). Used to detect
 * a group whose only available "title" is in fact its raw id, so we never persist a UUID
 * as a human-readable group name (see {@link defaultGroupTitle} / {@link ensureGroup}).
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * STG default group-title template. Mirrors `Lang('newGroupTitle', uid)` ("Group $id$",
 * see `_locales/.../messages.json`) with `uid = groups.extractUId(id)` (the id's last 4
 * chars). Duplicated as a literal here so the replay engine stays import-free / pure
 * (it cannot pull `groups.js`, which needs `Lang`/`Constants`/`Utils`). The visible
 * result for a UUID-titled group therefore matches what STG itself would name a new group.
 *
 * @param {string} groupId
 * @returns {string}
 */
function defaultGroupTitle(groupId) {
    const uid = (groupId == null ? '' : String(groupId)).slice(-4) || '{uid}';
    return `Group ${uid}`;
}

/**
 * Normalise a group title so a raw id / UUID is never written as a display title.
 *
 * A `tab.add`/`tab.modify` can reference a group whose `group.add` the receiver never saw
 * (missed or compacted away on this peer) — {@link ensureGroup} then fabricates the group
 * and, lacking any real props, used to fall back to the id itself, surfacing a group named
 * with a raw UUID in the UI with no later event to repair it (the sender won't re-emit
 * `group.add` for an id already in its baseline). When the only title we have IS the id or
 * looks like a UUID, substitute STG's own default name instead.
 *
 * @param {*} title - the candidate title (may be undefined/null/the id).
 * @param {string} groupId
 * @returns {string} a human-readable title (STG default when the candidate is a UUID/id).
 */
function sanitizeGroupTitle(title, groupId) {
    const str = title == null ? '' : String(title);
    if (!str || str === String(groupId) || UUID_RE.test(str)) {
        return defaultGroupTitle(groupId);
    }
    return str;
}

/**
 * Additive boolean tab flags whose ABSENCE on an incoming record must NOT be treated as
 * "turn off". `pinned` (group-scoped pin) and `loaded` (source loaded-state) are written
 * by capture only when relevant, so a `tab.modify` that carries neither could historically
 * WIPE a previously-synced `pinned:true`/`loaded:true` (the upserts wholesale-replace the
 * record). See {@link preserveAdditiveFlags}.
 */
const ADDITIVE_TAB_FLAGS = ['pinned', 'loaded'];

/**
 * Clobber-safety for the wholesale-replace upserts: when an incoming add/modify record
 * OMITS an additive flag (`pinned`/`loaded`) that the record it is replacing carried,
 * carry the prior value forward onto the incoming record — preserve, don't wipe.
 *
 * Rationale (the chosen fix; see DESIGN_DELTA_SYNC clobber note): capture now ALWAYS emits
 * these flags explicitly (true OR false), so a record produced by the current code never
 * omits them and a genuine un-pin / un-load carries `false` and DOES clear the flag. The
 * preserve here is the safety net for LEGACY records already in the cloud (captured before
 * the always-emit change) which carry the flag only when true: such a record omitting the
 * flag is ambiguous, and the safe reading — given events replay in global ts order so the
 * prior value reflects every earlier event — is "no information ⇒ keep what we had". A
 * present `false` is unambiguous and still clears it. `incoming` is mutated in place.
 *
 * @param {object} incoming - the record about to be inserted (mutated).
 * @param {object|undefined} prior - the same-uid record being replaced, if any.
 */
function preserveAdditiveFlags(incoming, prior) {
    if (!prior) {
        return;
    }
    for (const flag of ADDITIVE_TAB_FLAGS) {
        if (!Object.hasOwn(incoming, flag) && Object.hasOwn(prior, flag)) {
            incoming[flag] = prior[flag];
        }
    }
}

/** Op constants — kept in sync with `delta-log.js` OPS, duplicated to stay import-free. */
const OPS = {
    TAB_ADD: 'tab.add',
    TAB_MODIFY: 'tab.modify',
    TAB_MOVE: 'tab.move',
    TAB_REMOVE: 'tab.remove',
    GROUP_ADD: 'group.add',
    GROUP_MODIFY: 'group.modify',
    GROUP_MOVE: 'group.move',
    GROUP_REMOVE: 'group.remove',
    OPTION_SET: 'option.set',
    PINNED_ADD: 'pinned.add',
    PINNED_MODIFY: 'pinned.modify',
    PINNED_MOVE: 'pinned.move',
    PINNED_REMOVE: 'pinned.remove',
};

/**
 * Structured deep clone of a plain JSON-ish value (the shapes here are JSON: arrays,
 * objects, primitives). Avoids `structuredClone` to keep behaviour identical under
 * any node/browser version and to make the purity obvious.
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
 * Build the deterministic global replay order from all device logs.
 *
 * Per the design: order by `ts` ascending, tie-break by `deviceId` then `seq`. The
 * `(deviceId, seq)` tie-break makes the order total and reproducible regardless of
 * the order the logs were supplied in; within one device `seq` is authoritative even
 * if two events happen to share a `ts`.
 *
 * @param {Array<{deviceId: string, events: object[]}>} deltaLogs
 * @returns {Array<{deviceId: string, event: object}>} flattened, sorted entries
 */
function buildOrderedEvents(deltaLogs) {
    const entries = [];

    for (const log of deltaLogs || []) {
        const deviceId = log?.deviceId;
        for (const event of log?.events || []) {
            entries.push({deviceId, event});
        }
    }

    entries.sort((a, b) => {
        const tsA = a.event.ts ?? 0;
        const tsB = b.event.ts ?? 0;
        if (tsA !== tsB) {
            return tsA - tsB;
        }
        if (a.deviceId !== b.deviceId) {
            return a.deviceId < b.deviceId ? -1 : 1;
        }
        return (a.event.seq ?? 0) - (b.event.seq ?? 0);
    });

    return entries;
}

/**
 * Insert `tab` into `group.tabs` at the GROUP-RELATIVE position `index` (its 0-based
 * slot within this group's ordered tab list), keeping BOTH on a hard index conflict.
 *
 * `index` is strictly an array position within `group.tabs` — NOT a browser-window
 * index. Capture stores it group-relative (see delta-capture.js); replaying it as an
 * array slot is what keeps tab order identical across machines.
 *
 * Implements design rule 2 ("Duplicate on hard index conflict"): the incoming tab
 * takes the requested slot and whatever already sat there (and everything after it)
 * shifts down — no overwrite, no drop. A missing or out-of-range index CLAMPS to
 * append-at-end. The caller is responsible for having removed any same-uid tab first
 * when that is the intended semantics (add/move do; this helper is uid-agnostic).
 *
 * @param {{tabs: object[]}} group
 * @param {object} tab
 * @param {number} [index]
 */
function insertTabAt(group, tab, index) {
    const len = group.tabs.length;
    let at = Number.isInteger(index) ? index : len;
    if (at < 0) {
        at = 0;
    }
    if (at > len) {
        at = len;
    }
    group.tabs.splice(at, 0, tab);
}

/**
 * Find `[group, tabIndex]` for a tab `uid` anywhere in the snapshot, or nulls.
 * @param {object[]} groups
 * @param {string} uid
 * @returns {{group: object|null, tabIndex: number}}
 */
function findTab(groups, uid) {
    for (const group of groups) {
        const tabIndex = group.tabs.findIndex(t => t.uid === uid);
        if (tabIndex !== -1) {
            return {group, tabIndex};
        }
    }
    return {group: null, tabIndex: -1};
}

/**
 * Resolve (and if necessary recreate) the target group for a tab event.
 *
 * Implements design rule 3 ("Group fallback"): a tab event that references a group
 * which is gone recreates a MINIMAL group with that id so the tab still lands
 * somewhere recoverable rather than being dropped. We intentionally recreate by id
 * (not a single shared fallback bucket) so a later `group.add`/`group.modify` for the
 * same id naturally reconciles onto it (add-of-existing ⇒ modify) and the user keeps
 * the original grouping. Title defaults to STG's own "Group <uid>" name (never the raw
 * id/UUID — see {@link sanitizeGroupTitle}); the real title arrives via group.modify.
 *
 * @param {object[]} groups
 * @param {string} groupId
 * @returns {object} the existing or newly-created group
 */
function ensureGroup(groups, groupId) {
    let group = groups.find(g => g.id === groupId);
    if (!group) {
        group = {id: groupId, title: defaultGroupTitle(groupId), tabs: []};
        groups.push(group);
    }
    if (!Array.isArray(group.tabs)) {
        group.tabs = [];
    }
    return group;
}

/**
 * Apply a single tab.add / tab.modify event (they share resurrection semantics).
 *
 * - add of an existing uid ⇒ behaves as modify (design rule 5);
 * - modify of an absent uid ⇒ re-create it (design rule 1, modify-beats-delete);
 * - the tab always ends up in `groupId` (recreated if gone — rule 3);
 * - placement honours the event's `index` with the duplicate-on-conflict rule.
 *
 * @param {object[]} groups
 * @param {object} event - { groupId, tab }
 */
function applyTabUpsert(groups, event) {
    const incoming = deepClone(event.tab);
    if (!incoming || incoming.uid == null) {
        return; // malformed; nothing to key on
    }

    if (incoming.cookieStoreId == null) {
        incoming.cookieStoreId = DEFAULT_COOKIE_STORE_ID;
    }

    // Remove any existing copy of this uid first (modify replaces the full record,
    // add-of-existing folds to modify). This also handles a uid that had drifted into
    // a different group: it is re-homed to the event's groupId.
    const existing = findTab(groups, incoming.uid);
    if (existing.group) {
        // clobber-safety: an incoming record omitting pinned/loaded must not wipe a
        // previously-synced true value (legacy records carry these only when true).
        preserveAdditiveFlags(incoming, existing.group.tabs[existing.tabIndex]);
        existing.group.tabs.splice(existing.tabIndex, 1);
    }

    const target = ensureGroup(groups, event.groupId);
    insertTabAt(target, incoming, incoming.index);
}

/**
 * Apply a tab.move event: move `uid` to `toIndex` within `groupId`.
 *
 * - unknown uid ⇒ ignore (design: a later modify resurrects if needed);
 * - non-existent/out-of-range index ⇒ append at end (rule 3);
 * - duplicate-on-conflict applies at the destination slot (rule 2).
 *
 * @param {object[]} groups
 * @param {object} event - { groupId, uid, toIndex }
 */
function applyTabMove(groups, event) {
    const found = findTab(groups, event.uid);
    if (!found.group) {
        return; // unknown uid — ignore
    }

    const [tab] = found.group.tabs.splice(found.tabIndex, 1);

    const target = ensureGroup(groups, event.groupId);
    insertTabAt(target, tab, event.toIndex);
}

/**
 * Apply a tab.remove event: drop `uid` wherever it lives. Absent ⇒ no-op (rule 5).
 * @param {object[]} groups
 * @param {object} event - { uid }
 */
function applyTabRemove(groups, event) {
    const found = findTab(groups, event.uid);
    if (found.group) {
        found.group.tabs.splice(found.tabIndex, 1);
    }
}

/**
 * Insert `tab` into the flat `list` at `index`, keeping BOTH on a hard index conflict.
 * The pinned-tab analogue of {@link insertTabAt} (same rule 2 semantics) on a plain
 * array rather than a group's `tabs`. Missing / out-of-range index clamps to append.
 * @param {object[]} list
 * @param {object} tab
 * @param {number} [index]
 */
function insertInListAt(list, tab, index) {
    const len = list.length;
    let at = Number.isInteger(index) ? index : len;
    if (at < 0) {
        at = 0;
    }
    if (at > len) {
        at = len;
    }
    list.splice(at, 0, tab);
}

/**
 * Apply a pinned.add / pinned.modify event onto the flat `pinnedTabs` array.
 *
 * Same resurrection semantics as {@link applyTabUpsert} but on the single global
 * pinned list (no group): add-of-existing folds to modify, modify-of-absent
 * re-creates (rule 1, modify-beats-delete), placement honours `index` with the
 * duplicate-on-conflict rule.
 *
 * @param {object[]} pinnedTabs
 * @param {object} event - { tab }
 */
function applyPinnedUpsert(pinnedTabs, event) {
    const incoming = deepClone(event.tab);
    if (!incoming || incoming.uid == null) {
        return; // malformed; nothing to key on
    }

    if (incoming.cookieStoreId == null) {
        incoming.cookieStoreId = DEFAULT_COOKIE_STORE_ID;
    }

    const existingIdx = pinnedTabs.findIndex(t => t.uid === incoming.uid);
    if (existingIdx !== -1) {
        // clobber-safety: see applyTabUpsert. `loaded` is the only additive flag that
        // applies to a global pinned tab, but preserve both for uniformity.
        preserveAdditiveFlags(incoming, pinnedTabs[existingIdx]);
        pinnedTabs.splice(existingIdx, 1);
    }

    insertInListAt(pinnedTabs, incoming, incoming.index);
}

/**
 * Apply a pinned.move event: move `uid` to `toIndex` within the global pinned list.
 * Unknown uid ⇒ ignore (a later modify resurrects); out-of-range index ⇒ append.
 * @param {object[]} pinnedTabs
 * @param {object} event - { uid, toIndex }
 */
function applyPinnedMove(pinnedTabs, event) {
    const idx = pinnedTabs.findIndex(t => t.uid === event.uid);
    if (idx === -1) {
        return; // unknown uid — ignore
    }
    const [tab] = pinnedTabs.splice(idx, 1);
    insertInListAt(pinnedTabs, tab, event.toIndex);
}

/**
 * Apply a pinned.remove event: drop `uid` from the global pinned list. Absent ⇒ no-op.
 * @param {object[]} pinnedTabs
 * @param {object} event - { uid }
 */
function applyPinnedRemove(pinnedTabs, event) {
    const idx = pinnedTabs.findIndex(t => t.uid === event.uid);
    if (idx !== -1) {
        pinnedTabs.splice(idx, 1);
    }
}

/**
 * Apply a group.add / group.modify event.
 *
 * - add of an existing id ⇒ behaves as modify (rule 5);
 * - last-write-wins on group props;
 * - **tab membership is driven by tab.* events, never by group events.** Decision
 *   (per design note): we merge the event's group props onto the group but KEEP the
 *   replayed `tabs` array. A group.modify carrying a stale `tabs` snapshot must not
 *   clobber tabs that tab.add/move/remove events have already resolved. A brand-new
 *   group created here adopts the event's `tabs` only if it carried any (an add can
 *   legitimately seed initial tabs), else an empty array.
 *
 * @param {object[]} groups
 * @param {object} event - { group }
 */
function applyGroupUpsert(groups, event) {
    const incoming = deepClone(event.group);
    if (!incoming || incoming.id == null) {
        return;
    }

    const existing = groups.find(g => g.id === incoming.id);
    const {tabs: incomingTabs, ...props} = incoming;

    // Never let a real group event seed/overwrite the title with the raw id/UUID. A
    // genuine `group.add` carries the human title; a fabricated-elsewhere fallback (or a
    // sender that lost the title) must not surface a UUID as a group name. Only coerce
    // when the incoming event actually carries a `title` (a partial group.modify that
    // omits it must leave the existing title untouched).
    if (Object.hasOwn(props, 'title')) {
        props.title = sanitizeGroupTitle(props.title, incoming.id);
    }

    if (existing) {
        // merge props; keep the replayed tabs (membership owned by tab.* events)
        Object.assign(existing, props);
        if (!Array.isArray(existing.tabs)) {
            existing.tabs = [];
        }
    } else {
        groups.push({
            ...props,
            tabs: Array.isArray(incomingTabs) ? deepClone(incomingTabs) : [],
        });
    }
}

/**
 * Apply a group.move event: reorder `groupId` to 0-based array position `toIndex`.
 *
 * Group order IS array position in the snapshot (see replay header + plan-sync), so a
 * reorder is a splice-out / insert-at. Last-writer-wins falls out of the global event
 * order: the latest group.move (by ts, tie-break deviceId/seq) is applied last and wins.
 * An unknown groupId is a no-op (rule 5). A missing/out-of-range `toIndex` clamps to the
 * end (append), matching the tab.move append-on-unknown-index convention.
 *
 * @param {object[]} groups
 * @param {object} event - { groupId, toIndex }
 */
function applyGroupMove(groups, event) {
    const from = groups.findIndex(g => g.id === event.groupId);
    if (from === -1) {
        return; // unknown group — ignore
    }

    const [group] = groups.splice(from, 1);

    let to = Number.isInteger(event.toIndex) ? event.toIndex : groups.length;
    if (to < 0) {
        to = 0;
    }
    if (to > groups.length) {
        to = groups.length;
    }

    groups.splice(to, 0, group);
}

/**
 * Apply a group.remove event: drop the group and its tabs.
 *
 * Decision (per design): removing a group discards its current tabs. They are NOT
 * preserved, because a tab that genuinely survives the group's deletion will be
 * resurrected by its own later tab.modify into a (re-created) group via rule 1/3.
 * Removing an absent group is a no-op (rule 5).
 *
 * @param {object[]} groups
 * @param {object} event - { groupId }
 */
function applyGroupRemove(groups, event) {
    const idx = groups.findIndex(g => g.id === event.groupId);
    if (idx !== -1) {
        groups.splice(idx, 1);
    }
}

/**
 * Replay delta logs on top of a base snapshot and return the resolved state.
 *
 * Pure and deterministic: inputs are deep-cloned, never mutated. Events are merged
 * across all logs into one global order (ts asc, tie-break deviceId then seq), then
 * applied with the conflict rules documented above. Events already folded into the
 * base — `seq <= watermark[deviceId]` — are skipped (design rule 4, watermark dedup).
 *
 * @param {object} baseSnapshot - { groups: [...], watermark?: { [deviceId]: seq } }
 * @param {Array<{deviceId: string, events: object[]}>} deltaLogs
 * @param {object} [options] - reserved for future tuning; currently unused.
 * @returns {{snapshot: {groups: object[], pinnedTabs: object[], options: object, containers: object, watermark: object}, watermark: object}}
 *   The resolved snapshot (groups + global pinnedTabs + resolved options + carried-through
 *   container registry + updated watermark) and, for convenience, the same watermark object.
 *   `watermark[deviceId]` is the max applied seq
 *   per device — the max of the base watermark and the highest seq that survived dedup
 *   for that device. `snapshot.options` is the per-key LWW-resolved synced settings.
 */
export function replay(baseSnapshot, deltaLogs = [], options = {}) {
    void options;

    const groups = deepClone(baseSnapshot?.groups || []).map(group => ({
        ...group,
        tabs: Array.isArray(group.tabs) ? group.tabs : [],
    }));

    // Global pinned tabs fold into this flat ordered array (mirrors legacy data.pinnedTabs).
    const pinnedTabs = Array.isArray(baseSnapshot?.pinnedTabs) ? deepClone(baseSnapshot.pinnedTabs) : [];

    // Resolved synced global settings. Seeded from the base snapshot's options (folded
    // by a prior compaction) and overridden per-key as `option.set` events are applied
    // in global order — last-writer-wins by ts (the apply order already encodes it).
    const resolvedOptions = deepClone(baseSnapshot?.options || {});

    // Portable container registry ({portableKey: {name, color, icon}}). Carried through
    // unchanged: events reference containers only by their portable key, and the registry
    // is identity-derived (the same key always maps to the same {name,color,icon}), so it
    // needs no merge logic in the pure engine. The transport (delta-sync.js) folds THIS
    // device's local container defs into the result before writing/applying.
    const containers = deepClone(baseSnapshot?.containers || {});

    // The FROZEN base watermark — what is already baked into the base snapshot. Dedup
    // compares against this only; it must not drift as we fold, otherwise a device whose
    // ts order disagrees with its seq order (a later-seq event with an earlier ts) would
    // wrongly skip a still-pending lower-seq event. `seq` is per-device authoritative for
    // identity/dedup; `ts` only chooses the global apply order.
    const baseWatermark = baseSnapshot?.watermark || {};

    // The RETURNED watermark — max seq actually applied per device. Seeded from the base
    // so a device that contributed nothing this round keeps its folded high-water mark.
    const watermark = {...baseWatermark};

    const ordered = buildOrderedEvents(deltaLogs);

    for (const {deviceId, event} of ordered) {
        const folded = baseWatermark[deviceId] ?? 0;

        // watermark dedup: skip events already baked into the base (rule 4)
        if (event.seq != null && event.seq <= folded) {
            continue;
        }

        switch (event.op) {
            case OPS.TAB_ADD:
            case OPS.TAB_MODIFY:
                applyTabUpsert(groups, event);
                break;
            case OPS.TAB_MOVE:
                applyTabMove(groups, event);
                break;
            case OPS.TAB_REMOVE:
                applyTabRemove(groups, event);
                break;
            case OPS.GROUP_ADD:
            case OPS.GROUP_MODIFY:
                applyGroupUpsert(groups, event);
                break;
            case OPS.GROUP_MOVE:
                applyGroupMove(groups, event);
                break;
            case OPS.GROUP_REMOVE:
                applyGroupRemove(groups, event);
                break;
            case OPS.PINNED_ADD:
            case OPS.PINNED_MODIFY:
                applyPinnedUpsert(pinnedTabs, event);
                break;
            case OPS.PINNED_MOVE:
                applyPinnedMove(pinnedTabs, event);
                break;
            case OPS.PINNED_REMOVE:
                applyPinnedRemove(pinnedTabs, event);
                break;
            case OPS.OPTION_SET:
                // per-key last-writer-wins: events arrive in global ts order, so the
                // last write for a key (by ts, tie-break deviceId/seq) overrides.
                if (event.key != null) {
                    resolvedOptions[event.key] = deepClone(event.value);
                }
                break;
            default:
                // unknown op: skip but still advance the watermark below so a future
                // schema addition replayed by an old engine never re-folds it.
                break;
        }

        // advance watermark to the max applied seq for this device
        if (event.seq != null && (watermark[deviceId] == null || event.seq > watermark[deviceId])) {
            watermark[deviceId] = event.seq;
        }
    }

    // The resolved `group.tabs` ARRAY ORDER is the single authoritative tab order. Stamp
    // each tab's `index` to its array position so the persisted field can never diverge
    // from the array (a stale browser-absolute or group-relative `index` carried in from
    // a base snapshot / event record would otherwise be misread downstream). Consumers
    // that need an order use the array position; this just keeps the field honest.
    for (const group of groups) {
        group.tabs.forEach((tab, position) => {
            tab.index = position;
        });
    }

    // Same contract for the global pinned strip: the resolved `pinnedTabs` ARRAY ORDER is
    // authoritative, so stamp each pinned tab's `index` to its array position (pinned tabs
    // are first in the window, so the pinned-relative position is also their browser index).
    pinnedTabs.forEach((tab, position) => {
        tab.index = position;
    });

    return {
        snapshot: {groups, pinnedTabs, options: resolvedOptions, containers, watermark},
        watermark,
    };
}
