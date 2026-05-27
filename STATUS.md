# Session Status — 2026-05-25

## Goal

Multi-image Nordic Secure DFU browser test passing end-to-end.

## What was fixed this session

### 1. `tools/nordic-dfu-test.mjs`

- Default `BOOTLOADER_NAME` changed `DfuTarg` → `DfuTest` (SDK 17.1.0 sample `sdk_config.h` overrides the header default)

### 2. `nordic/secure-dfu.js` — multiple fixes

- PRN disabled (was 10) — opcode 0x03 conflict with `CALCULATE_CHECKSUM` caused `org.bluez.Error.InProgress` cascade
- `sendOperation` — 30s notification timeout; reject with `Error` objects (not bare strings — caused `undefined` in error messages)
- Disconnect handling in `connect()` — rejects all pending `_notifyFns` on GATT disconnect
- `transferObject` — CRC-fail streak cap at 4; returns `{transferred, ok}` shape
- Added `_writePacketWithRetry` + `_isTransientWriteError` for transient BlueZ write errors
- `handleNotification` — wraps rejection in `new Error()`

### 3. `tools/ble-characteristic.mjs`

- `stopNotifications()` — wrapped in try/catch to suppress D-Bus "Not connected" on teardown

### 4. `Makefile`

- `browser-test-nordic-headless` and `browser-test-nordic-multi-headless` — removed `HEADLESS=1` (true headless Chrome blocks Web Bluetooth; Xvfb is the correct approach)
- Added `browser-test-nordic-headless`, `browser-test-nordic-multi`, `browser-test-nordic-multi-headless` to `.PHONY`

### 5. `index.html`

- Added missing `<span class="file-size" id="file-size"></span>` element (its absence caused `fileSizeEl.textContent = ...` to crash before `showProtocol()` was reached, so the protocol badge never appeared after file upload)

### 6. `app.js`

- `showProtocol()` — changed `style.display = p ? '' : 'none'` to `style.display = p ? 'inline' : 'none'` (empty string doesn't override CSS `display:none` from `.protocol-badge` class)

### 7. `nordic/secure-dfu.js` — reconnect race fix

- Added `_disconnectCleanupFn` field
- `connect()` now removes stale disconnect + notify listeners before registering new ones — prevents late-firing `gattserverdisconnected` from app-mode device nulling `_controlChar`/`_packetChar` after bootloader `connect()` already set them
- Disconnect handler now rejects all pending `_notifyFns` promises (was just `{}` reassignment — hung in-flight promises)

## Current state

Reconnect race fixed. Ready to re-run:

```bash
make browser-test-nordic-multi-headless ZIP=/tmp/multi_image_dfu_test.zip
```

The ZIP `/tmp/multi_image_dfu_test.zip` (171.9 KB) still exists.

Expected: past reconnect into init-packet transfer without null `writeValueWithResponse` crash.

## Known remaining issue

WSL2 + node-ble headless harness (`tools/nordic-dfu-test.mjs`) disconnects at chunk 2 mid-transfer. This is environmental (usbipd BT400 + WSL2 GATT flow control). The browser path (Puppeteer + Web Bluetooth) does not have this problem — browser handles BLE flow control natively. The node-ble path is deprioritized.

## Git state

All fixes are uncommitted. Files changed:

- `nordic/secure-dfu.js`
- `smp/mcumgr.js` (from earlier session, already had changes)
- `tools/ble-characteristic.mjs`
- `tools/nordic-dfu-test.mjs`
- `Makefile`
- `index.html`
- `app.js`
