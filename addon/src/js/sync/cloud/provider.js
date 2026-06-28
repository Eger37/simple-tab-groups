
import GithubGist from './githubgist.js';

/**
 * Provider-type constants. These identify which cloud backend the sync engine
 * talks to. The selected value is stored as the local (per-device) option
 * `syncProvider` (see `DEFAULT_OPTIONS` in constants.js) and is NOT part of the
 * synced payload.
 */
export const PROVIDER_GITHUB_GIST = 'github-gist';
export const PROVIDER_GOOGLE_DRIVE = 'google-drive';

/**
 * CloudProvider contract.
 *
 * The sync engine (`cloud.js`) is provider-agnostic: it only depends on the
 * methods documented below. Any new backend must implement this same contract
 * so it can be returned by `createCloudProvider()` without further changes to
 * the engine.
 *
 * @typedef {Object} CloudInfo
 * @property {string} lastUpdate - ISO 8601 timestamp of the last cloud update
 *      (e.g. `"2024-01-01T00:00:00Z"`). Used by the engine to decide the source
 *      of truth (local vs cloud).
 *
 * @typedef {Object} CloudProvider
 *
 * @property {(revision: ?string, progressFunc: ?function) => Promise<CloudInfo>} getInfo
 *      Fetch metadata about the current cloud content (optionally for a given
 *      revision). Resolves with a `CloudInfo`. Throws `Error('githubNotFound')`
 *      (provider-specific "not found" marker) when there is no cloud content yet.
 *
 * @property {(revision: ?string, withInfo: ?boolean, progressFunc: ?function) => Promise<(Object|[Object, CloudInfo])>} getContent
 *      Fetch the stored backup content. When `withInfo` is falsy, resolves with
 *      the parsed content object. When `withInfo` is truthy, resolves with the
 *      tuple `[content, info]` where `info` is a `CloudInfo`. Throws
 *      `Error('githubNotFound')` when there is no cloud content yet (the engine
 *      treats this as "first sync").
 *
 * @property {(content: Object, description: ?string, progressFunc: ?function) => Promise<CloudInfo>} setContent
 *      Upload/replace the backup content. Resolves with the resulting
 *      `CloudInfo` (notably `info.lastUpdate`, which the engine writes back to
 *      `syncLastUpdate`).
 *
 * @property {() => Promise<(boolean|undefined)>} checkToken
 *      Validate the provider credentials. Used by the options UI. Resolves
 *      (truthy/undefined) when valid; throws a provider-specific error otherwise.
 *
 * --- Multi-file (delta-era) methods (Phase P3a) -------------------------------
 * These back the hybrid snapshot + delta layout (one container holding
 * `STG-sync-snapshot.json` + per-device `STG-sync-delta-<deviceId>.json`; see
 * `.project/DESIGN_DELTA_SYNC.md` and `../delta/layout.js`). They are ADDITIVE:
 * the single-file methods above remain the contract the current `cloud.js` sync
 * flow uses. A multi-file container is located by the presence of the snapshot
 * file, so absence of the container resolves to "empty" rather than throwing.
 *
 * @property {(name: string, progressFunc: ?function) => Promise<?Object>} readFile
 *      Read+parse one named file from the container. Resolves with the parsed
 *      content, or `null` if the file (or the whole container) is absent. Large
 *      files are fetched transparently. A malformed JSON file throws
 *      `Error('githubInvalidGistContent')`.
 *
 * @property {(progressFunc: ?function) => Promise<string[]>} listFiles
 *      List the names of every file in the container (`[]` if no container yet).
 *
 * @property {(prefix: string, progressFunc: ?function) => Promise<Array<{name: string, content: Object}>>} readAllMatching
 *      Read+parse every file whose name starts with `prefix` (e.g. all per-device
 *      delta logs). Resolves with `[{name, content}, ...]` (`[]` if no container).
 *
 * @property {(contents: Object<string, Object>, description: ?string, progressFunc: ?function) => Promise<CloudInfo>} writeFiles
 *      Write multiple files in a single atomic request (creating the container on
 *      first write). `contents` maps file name → content object. Resolves with the
 *      resulting `CloudInfo`. Per-file granularity lets concurrent devices write
 *      their own delta files without clobbering each other.
 *
 * @property {(name: string, progressFunc: ?function) => Promise<CloudInfo>} deleteFile
 *      Delete a single named file from the container (compaction primitive, P4).
 *      Resolves with the resulting `CloudInfo`. Throws `Error('githubNotFound')`
 *      if there is no container.
 *
 * --- Conditional-pull fast path (optimization, optional) ----------------------
 * Lets the sync engine skip the download + replay/apply when the remote container is
 * byte-for-byte unchanged since the last cycle, using the backend's native conditional
 * request (e.g. HTTP ETag / If-None-Match). Both methods are OPTIONAL and FAIL-SAFE: a
 * provider that doesn't implement them simply omits them, and the engine falls back to an
 * unconditional full fetch (correctness is identical either way).
 *
 * @property {(progressFunc: ?function) => Promise<boolean>} [isUnchangedSince]
 *      Probe whether the container changed since the last pull. Resolves `true` ONLY when
 *      the backend positively confirms "unchanged" (so the engine may skip pull+apply this
 *      cycle); resolves `false` on ANY doubt (no prior marker, first sync, discovery, or
 *      transport error) so the engine does a full fetch. MUST NOT throw.
 *
 * @property {(progressFunc: ?function) => Promise<void>} [refreshEtagFromWrite]
 *      Refresh the provider's stored conditional-request marker from the container's
 *      current state after a successful write/push, so the NEXT `isUnchangedSince` probe
 *      compares against the just-pushed revision. Best-effort; MUST NOT throw.
 *
 * --- Advisory distributed lock (Part A, optional) -----------------------------
 * Serializes sync cycles across devices so two don't write the snapshot concurrently. Since
 * the backend has no atomic compare-and-set (a gist `If-Match` PATCH returns a bare 400), the
 * lock is ADVISORY: acquire = write-then-read-back-to-confirm; a crashed holder is reclaimed
 * via a server-clock TTL. All three methods are OPTIONAL: a provider omitting them simply runs
 * unserialized (deferred self-truncation in delta-sync.js is the data-safety backstop).
 *
 * @property {(deviceId: string, progressFunc: ?function) => Promise<boolean>} [acquireLock]
 *      Try to acquire the lock for `deviceId`. Resolves `true` iff this device now holds it,
 *      `false` if a peer holds a fresh lock or on ANY error (caller skips + retries). MUST NOT throw.
 *
 * @property {(progressFunc: ?function) => Promise<void>} [releaseLock]
 *      Release the lock (delete the lock file). Idempotent + best-effort; MUST NOT throw.
 *      Always call in a `finally` (success, error, and watchdog paths).
 *
 * @property {() => ?number} [getServerTimeMs]
 *      The SERVER time (ms) most recently observed from a response `Date` header, or null if
 *      none seen yet. Lets the lock judge TTLs against the backend clock, not the device's.
 *
 * Notes:
 * - `progressFunc` is an optional `(percent: number) => void` callback the
 *   provider may call to report transfer progress.
 * - Errors thrown by providers use short language-id messages (see `Lang`),
 *   which `cloud.js` wraps in `CloudError`.
 */

/**
 * Factory that returns the cloud provider instance for the given type.
 *
 * Existing GitHub Gist users (no `syncProvider`, or `syncProvider === 'github-gist'`)
 * get exactly the same `GithubGist` instance as before, so behavior is preserved.
 *
 * @param {string} providerType - one of the `PROVIDER_*` constants.
 * @param {Object} syncOptions - the resolved sync options (token, file name, ...).
 * @returns {CloudProvider}
 */
export function createCloudProvider(providerType, syncOptions) {
    switch (providerType) {
        case PROVIDER_GOOGLE_DRIVE:
            // Extension point: a later branch will return a GoogleDrive provider
            // instance here, implementing the CloudProvider contract above.
            throw new Error('cloudProviderNotImplemented');

        case PROVIDER_GITHUB_GIST:
        default:
            // Default/fallback so existing users (and unset option) keep working. The gist is
            // identified by `githubGistName` (its description); the file name is only the file
            // this provider reads/writes inside that gist. The delta layout (STG-sync-*) and the
            // Cloud backup file thus share one named gist, differing only by file name.
            return new GithubGist(
                syncOptions.githubGistToken,
                syncOptions.githubGistFileName,
                syncOptions.githubGistName
            );
    }
}
