
/**
 * Portable container identity mapping for delta sync (Phase P3c — container parity).
 *
 * Firefox contextual identities ("containers" / Multi-Account Containers) are referenced
 * everywhere by their `cookieStoreId` (e.g. `firefox-container-1`). That id is assigned
 * per-install and is NOT stable across machines: the SAME logical "Work" container is
 * `firefox-container-1` on one PC and `firefox-container-3` on another. Syncing the raw
 * id would land a tab in the wrong (or a non-existent) container on the receiving side.
 *
 * So the synced model never carries a raw `cookieStoreId`. Instead every container-
 * referencing field carries a PORTABLE KEY derived from the container's identity
 * (`name + color + icon`, via {@link stringifyContainer} — exactly the legacy
 * `cloud.js` `stringifyContainer`), and a per-snapshot registry maps that key back to
 * the `{name, color, icon}` needed to find-or-create the matching local container on the
 * receiving device. This is a direct port of the legacy `cloud.js` `syncContainers` /
 * `mapContainers` / `mapDataContainers` / `eachGroupContainerKeyMap` approach into the
 * delta model.
 *
 * Two reserved markers are NEVER stored as real containers in the registry:
 *   - {@link DEFAULT_MARKER} — the default (no) container; translated to the local
 *     default `cookieStoreId` on the receiving side (whose literal value can differ,
 *     e.g. `icecat-default` vs `firefox-default`).
 *   - {@link TEMPORARY_MARKER} — a temporary container; never a stable identity, so it is
 *     never recreated as a named container (the receiving side maps it to its own
 *     temporary/default per its `mapToLocal` callback).
 *
 * ## Purity (hard requirement)
 * This module is PURE: no `browser.*`, no `constants.js` import. The two reserved
 * marker literals mirror `Constants.DEFAULT_COOKIE_STORE_ID_FIREFOX` /
 * `Constants.TEMPORARY_CONTAINER` but are local literals so the engine and its tests run
 * under plain `node`. The IMPURE boundary (resolving a portable key to a real local
 * `cookieStoreId`, find-or-creating the container) lives in `delta-sync.js`, which passes
 * its resolver in as a callback. Inputs are mutated IN PLACE by the mappers (the caller
 * owns fresh clones — `buildLocalState` / `deepClone`d events / `browserOps`), matching
 * the legacy `eachGroupContainerKeyMap` contract.
 *
 * @module sync/delta/container-map
 */

/**
 * Reserved portable key for the DEFAULT (no) container. Mirrors
 * `Constants.DEFAULT_COOKIE_STORE_ID_FIREFOX`; a literal here keeps the module pure.
 * Use the canonical firefox value (not the per-browser `DEFAULT_COOKIE_STORE_ID`) so the
 * marker is identical across IceCat/Firefox installs — the local literal value is
 * substituted back only at the inbound boundary.
 * @readonly
 */
export const DEFAULT_MARKER = 'firefox-default';

/**
 * Reserved portable key for a TEMPORARY container. Mirrors `Constants.TEMPORARY_CONTAINER`.
 * Never stored in the registry as a real container (temporary containers have no stable
 * identity to recreate).
 * @readonly
 */
export const TEMPORARY_MARKER = 'temporary-container';

/**
 * Group (and `defaultGroupProps`) keys that reference a container. `newTabContainer` is a
 * single `cookieStoreId`; `catchTabContainers` / `excludeContainersForReOpen` are arrays
 * of them. Mirrors the legacy `cloud.js` `GROUP_CONTAINER_KEYS`.
 * @readonly
 */
export const GROUP_CONTAINER_KEYS = Object.freeze([
    'newTabContainer',
    'catchTabContainers',
    'excludeContainersForReOpen',
]);

/**
 * Build the portable key for a container identity — `name + color + icon` joined. A direct
 * port of the legacy `cloud.js` `stringifyContainer`. Reserved markers (default/temporary)
 * are passed through untouched so this is safe to call on an already-portable value.
 * @param {{name?: string, color?: string, icon?: string}} container
 * @returns {string}
 */
export function stringifyContainer({name, color, icon} = {}) {
    return [name, color, icon].join('');
}

/**
 * Walk every container-referencing field of a single group-shaped object (a group OR
 * `defaultGroupProps`) and replace each `cookieStoreId` via `mapFn`. Mirrors the legacy
 * `eachGroupContainerKeyMap`: a scalar field stays scalar, an array field stays an array.
 * The group's `tabs` (when present) have each tab's `cookieStoreId` mapped too. Mutates
 * `group` in place; absent fields are left untouched.
 *
 * @param {object} group - a group or defaultGroupProps object.
 * @param {(cookieStoreId: string) => string} mapFn - portable<->local translator.
 */
export function mapGroupContainers(group, mapFn) {
    if (!group || typeof group !== 'object') {
        return;
    }

    for (const key of GROUP_CONTAINER_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(group, key)) {
            continue;
        }
        const value = group[key];
        if (Array.isArray(value)) {
            group[key] = value.map(csId => mapFn(csId));
        } else if (value != null) {
            group[key] = mapFn(value);
        }
    }

    if (Array.isArray(group.tabs)) {
        for (const tab of group.tabs) {
            if (tab && tab.cookieStoreId != null) {
                tab.cookieStoreId = mapFn(tab.cookieStoreId);
            }
        }
    }
}

/**
 * Map the container field(s) of a single delta EVENT in place (matches the event payload
 * shapes in `replay.js`): `tab.add/modify` carry `event.tab.cookieStoreId`; `pinned.*`
 * carry `event.tab.cookieStoreId`; `group.add/modify` carry `event.group` (a full group
 * record with the group container keys, mapped via {@link mapGroupContainers}); and an
 * `option.set` for `defaultGroupProps` carries its container keys in `event.value`.
 *
 * @param {object} event - a delta event (`{op, ...}`).
 * @param {(cookieStoreId: string) => string} mapFn
 */
export function mapEventContainers(event, mapFn) {
    if (!event || typeof event !== 'object') {
        return;
    }

    if (event.tab && event.tab.cookieStoreId != null) {
        event.tab.cookieStoreId = mapFn(event.tab.cookieStoreId);
    }

    if (event.group) {
        mapGroupContainers(event.group, mapFn);
    }

    // option.set for defaultGroupProps carries container keys inside its value.
    if (event.op === 'option.set' && event.key === 'defaultGroupProps' && event.value) {
        mapGroupContainers(event.value, mapFn);
    }
}

/**
 * Map every container field across a whole snapshot-shaped state in place: each group
 * (via {@link mapGroupContainers}, which also covers its tabs), each global pinned tab,
 * and `options.defaultGroupProps` when present. Used for both the localState (outbound)
 * and the resolved snapshot's container fields.
 *
 * @param {object} state - `{groups?, pinnedTabs?, options?, defaultGroupProps?}`.
 * @param {(cookieStoreId: string) => string} mapFn
 */
export function mapStateContainers(state, mapFn) {
    if (!state || typeof state !== 'object') {
        return;
    }

    for (const group of Array.isArray(state.groups) ? state.groups : []) {
        mapGroupContainers(group, mapFn);
    }

    for (const tab of Array.isArray(state.pinnedTabs) ? state.pinnedTabs : []) {
        if (tab && tab.cookieStoreId != null) {
            tab.cookieStoreId = mapFn(tab.cookieStoreId);
        }
    }

    // defaultGroupProps roams as a synced option value (a group-shaped object).
    if (state.options && state.options.defaultGroupProps) {
        mapGroupContainers(state.options.defaultGroupProps, mapFn);
    }
    // also support a top-level defaultGroupProps (e.g. an options bag passed directly).
    if (state.defaultGroupProps) {
        mapGroupContainers(state.defaultGroupProps, mapFn);
    }
}

/**
 * Make the OUTBOUND local→portable translator for a given set of local containers and a
 * registry to populate. Returns a `mapFn(cookieStoreId) => portableKey` that:
 *   - default container ⇒ {@link DEFAULT_MARKER};
 *   - temporary container ⇒ {@link TEMPORARY_MARKER} (never registered as a real container);
 *   - any other known local container ⇒ its {@link stringifyContainer} key, AND records its
 *     `{name, color, icon}` into `registry[key]` so the receiving side can recreate it;
 *   - an unknown `cookieStoreId` (no local definition — e.g. a container removed out from
 *     under us) ⇒ {@link DEFAULT_MARKER} (conservative: never fail the sync, fall back to
 *     default — mirrors the legacy code's missing-definition handling).
 *
 * @param {object} localContainers - `{[cookieStoreId]: {name, color, icon}}` (real, non-temp).
 * @param {object} registry - mutated in place: `{[portableKey]: {name, color, icon}}`.
 * @param {(cookieStoreId: string) => boolean} isDefault - default-container predicate.
 * @param {(cookieStoreId: string) => boolean} isTemporary - temporary-container predicate.
 * @returns {(cookieStoreId: string) => string}
 */
export function makeOutboundMapper(localContainers, registry, isDefault, isTemporary) {
    return cookieStoreId => {
        if (cookieStoreId == null || isDefault(cookieStoreId)) {
            return DEFAULT_MARKER;
        }
        if (isTemporary(cookieStoreId)) {
            return TEMPORARY_MARKER;
        }

        const container = localContainers[cookieStoreId];
        if (!container) {
            // unknown / missing definition ⇒ fall back to default (never fail the sync).
            return DEFAULT_MARKER;
        }

        const key = stringifyContainer(container);
        if (!registry[key]) {
            registry[key] = {
                name: container.name,
                color: container.color,
                icon: container.icon,
            };
        }
        return key;
    };
}

/**
 * Make the INBOUND portable→local translator for a given registry. Returns a
 * `mapFn(portableKey) => cookieStoreId` that:
 *   - {@link DEFAULT_MARKER} (or null) ⇒ the local default `cookieStoreId` (`localDefault`);
 *   - {@link TEMPORARY_MARKER} ⇒ resolved by `resolveTemporary()` (caller decides: a fresh
 *     temporary container, or the local default — conservative);
 *   - a registered portable key ⇒ `findOrCreate({name, color, icon})`'s local cookieStoreId,
 *     CACHED per round so a container is created at most once;
 *   - an unknown key with no registry entry ⇒ the local default (missing definition ⇒
 *     fall back to default; never fail the sync — mirrors the legacy code).
 *
 * `findOrCreate` and `resolveTemporary` are the IMPURE injection points (they touch
 * `Containers.*`); this function itself stays pure aside from invoking them.
 *
 * @param {object} registry - `{[portableKey]: {name, color, icon}}` from the snapshot.
 * @param {string} localDefault - this install's default `cookieStoreId`.
 * @param {(identity: {name, color, icon}) => string} findOrCreate - resolve a portable
 *   identity to a local cookieStoreId (find existing match or create).
 * @param {() => string} resolveTemporary - resolve the temporary marker to a local id.
 * @returns {(portableKey: string) => string}
 */
export function makeInboundMapper(registry, localDefault, findOrCreate, resolveTemporary) {
    const cache = new Map();

    return portableKey => {
        if (portableKey == null || portableKey === DEFAULT_MARKER) {
            return localDefault;
        }
        if (portableKey === TEMPORARY_MARKER) {
            if (!cache.has(portableKey)) {
                cache.set(portableKey, resolveTemporary());
            }
            return cache.get(portableKey);
        }

        if (cache.has(portableKey)) {
            return cache.get(portableKey);
        }

        const identity = registry && registry[portableKey];
        if (!identity) {
            // missing definition ⇒ fall back to default (never fail the sync).
            cache.set(portableKey, localDefault);
            return localDefault;
        }

        const cookieStoreId = findOrCreate({
            name: identity.name,
            color: identity.color,
            icon: identity.icon,
        });
        cache.set(portableKey, cookieStoreId);
        return cookieStoreId;
    };
}
