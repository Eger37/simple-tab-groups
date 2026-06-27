
/**
 * Per-install device identity for delta sync (Phase P1).
 *
 * Each install owns a persistent `deviceId` (UUID) plus a human-readable `label`.
 * The id names this device's append-only delta file in the cloud layout
 * (`STG-delta-<deviceId>.json`) and keys per-device watermarks; the label is only
 * surfaced to the user. See `.project/DESIGN_DELTA_SYNC.md` "Device identity".
 *
 * Generated once on first read and reused thereafter.
 *
 * Backing store: the synchronous prefixed `localStorage` under the CLOUD module,
 * matching how other durable cloud config is kept (`githubGistFileName`,
 * `lastError` in cloud.js). localStorage persists across browser restarts for the
 * background page, and the identity is tiny + read frequently, so a synchronous
 * store avoids an await on every delta append. The CLOUD root is never cleared on
 * start (only its `sync` sub-storage is), so the identity survives restarts.
 *
 * P1 is inert: nothing consumes the id yet.
 */

import '/js/prefixed-storage.js';
import * as Constants from '/js/constants.js';

const storage = localStorage.create(Constants.MODULES.CLOUD);

const DEVICE_ID_KEY = 'deviceId';
const DEVICE_LABEL_KEY = 'deviceLabel';

/**
 * Returns this install's stable device id (UUID), generating + persisting it once.
 * @returns {string}
 */
export function getDeviceId() {
    let deviceId = storage[DEVICE_ID_KEY];

    if (!deviceId) {
        deviceId = self.crypto.randomUUID();
        storage[DEVICE_ID_KEY] = deviceId;
    }

    return deviceId;
}

/**
 * Returns the human-readable device label. Defaults to the browser full name
 * (e.g. "Firefox Mozilla") the first time it's read; persisted thereafter so a
 * future user-set label is honoured.
 * @returns {string}
 */
export function getDeviceLabel() {
    let label = storage[DEVICE_LABEL_KEY];

    if (!label) {
        label = Constants.BROWSER_FULL_NAME;
        storage[DEVICE_LABEL_KEY] = label;
    }

    return label;
}

/**
 * Overrides the human-readable device label (e.g. from a future settings UI).
 * @param {string} label
 */
export function setDeviceLabel(label) {
    storage[DEVICE_LABEL_KEY] = label;
}
