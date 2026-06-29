
/**
 * Cloud storage layout naming for hybrid snapshot + delta sync (Phase P3a).
 *
 * Single source of truth for the file names the gist holds (see
 * `.project/DESIGN_DELTA_SYNC.md` "Raskladka"/storage layout):
 *   - `STG-sync-snapshot.json`        — the compacted base snapshot.
 *   - `STG-sync-delta-<deviceId>.json` — one append-only delta log per device.
 *
 * ## Purity
 * This module is PURE (literals only, no `browser.*`, no `constants.js` import) so
 * it can be shared by the pure planner/seed AND by the impure gist client. The
 * names intentionally mirror `Constants.GIT_GIST_FILE_NAME_PARTS` (`STG-`/`.json`)
 * but are duplicated as literals here to keep this module import-free.
 *
 * @module sync/delta/layout
 */

/** Reserved filename prefix owned by the delta-sync layout; the Cloud backup file must not use it. */
export const RESERVED_FILE_PREFIX = 'STG-sync-';

/** The compacted base snapshot file. */
export const SNAPSHOT_FILE_NAME = 'STG-sync-snapshot.json';

/** Filename prefix for per-device delta logs (`STG-sync-delta-<deviceId>.json`). */
export const DELTA_FILE_PREFIX = 'STG-sync-delta-';

/**
 * Advisory distributed-lock file. Holds `{deviceId, expiresAt}` (`expiresAt` is an
 * ABSOLUTE time on the SERVER clock, ms) and serializes sync cycles across devices so two
 * devices don't write the snapshot concurrently. ADVISORY/best-effort only: GitHub has no
 * conditional write (an `If-Match` PATCH returns a bare 400), so the lock is acquired by
 * write-then-read-back-to-confirm, not compare-and-set. Deferred self-truncation
 * (see {@link module:sync/delta/compaction}) is the data-safety backstop. See
 * {@link module:sync/delta/lock}.
 */
export const LOCK_FILE_NAME = 'STG-sync-lock.json';

/** Common suffix of every layout file. */
const FILE_SUFFIX = '.json';

/**
 * Build the delta filename for a device id (`STG-sync-delta-<deviceId>.json`).
 * @param {string} deviceId
 * @returns {string}
 */
export function deltaFileName(deviceId) {
    return `${DELTA_FILE_PREFIX}${deviceId}${FILE_SUFFIX}`;
}

/**
 * Extract the device id from a delta filename, or null if it is not one.
 * @param {string} fileName
 * @returns {string|null}
 */
export function deviceIdFromDeltaFileName(fileName) {
    if (typeof fileName !== 'string' || !fileName.startsWith(DELTA_FILE_PREFIX) || !fileName.endsWith(FILE_SUFFIX)) {
        return null;
    }
    return fileName.slice(DELTA_FILE_PREFIX.length, -FILE_SUFFIX.length) || null;
}

/**
 * Whether a filename collides with the reserved delta-sync namespace.
 * @param {string} fileName
 * @returns {boolean}
 */
export function isReservedFileName(fileName) {
    return typeof fileName === 'string' && fileName.startsWith(RESERVED_FILE_PREFIX);
}
