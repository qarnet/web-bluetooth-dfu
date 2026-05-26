# web-bluetooth-dfu — agent guidance

Browser-based firmware updater for nRF devices over Bluetooth LE.
Supports **SMP / MCUboot** (Zephyr / nRF Connect SDK) and **Nordic Secure DFU**
(nRF5 SDK) protocols with automatic detection.

Vanilla HTML + ES modules, no build step, no runtime npm dependencies.

## Architecture constraints

- **No build step.** The browser loads modules directly. Do not add a bundler (webpack, Vite, esbuild), transpiler, or framework (React, Vue, Svelte).
- **No runtime npm dependencies.** If a library is needed, vendor it as a single ES module in `vendor/`. Dependencies installed in `tools/` (puppeteer, node-ble) are dev-only and not shipped with the app.
- **HTTPS or localhost only.** Web Bluetooth requires a secure context. The README documents the Chrome flag for local HTTP (`unsafely-treat-insecure-origin-as-secure`).

## Project layout

| File | Responsibility |
|---|---|
| `index.html` | DOM, inline CSS, no framework |
| `app.js` | UI orchestration and DFU state machine |
| `bluetooth/connect.js` | Web Bluetooth device picker, GATT connect/disconnect, service enumeration |
| `core/events.js` | EventTarget base for providers |
| `core/provider.js` | `DfuProvider` base class + capability flags |
| `core/registry.js` | Static table of known providers (UUIDs, file matchers) |
| `core/detect.js` | Device + file detection, conflict resolution |
| `smp/cbor.js` | Minimal CBOR encoder/decoder |
| `smp/mcumgr.js` | SMP protocol engine (transport-decoupled, write queue) |
| `smp/smp-provider.js` | DfuProvider adapter for SMP/MCUboot |
| `nordic/secure-dfu.js` | Nordic Secure DFU transfer engine with cross-platform event polyfills |
| `nordic/package.js` | `.zip` parser for Nordic DFU packages |
| `nordic/nordic-provider.js` | DfuProvider adapter for Nordic Secure DFU |
| `vendor/cbor-x.js` | Vendored CBOR library |
| `vendor/jszip.mjs` | Vendored JSZip ESM bundle |
| `vendor/crc32.js` | Vendored CRC-32 implementation matching Nordic firmware algorithm |

## SMP protocol quirks

- **Header:** 8 bytes big-endian: `Op(1) | Flags(1) | Length(2) | Group(2) | Seq(1) | Cmd(1)`.
- **Transport:** GATT Write Without Response for requests, GATT Notifications for responses. UUIDs are in `bluetooth/connect.js`.
- **Queued writes:** `writeValueWithoutResponse` throws if called while another is in flight. `MCUManager` (in `smp/mcumgr.js`) handles this internally via `#enqueue` — direct access to the characteristic should not be needed.
- **Timeout:** `MCUManager.send()` times out after 30s. The **reset command is expected to timeout** because the device disconnects immediately; callers should catch and ignore the timeout (see `SmpProvider.runUpdate()` implementation).
- **Seq tracking:** `seq` is an auto-incrementing `& 0xff` byte used to match requests with notifications.

## CBOR gotcha

The MCUboot `zcbor` decoder on the device rejects cbor-x's default "records" tag and tagged `Uint8Array`s.

```js
const cbor = new Encoder({ useRecords: false, tagUint8Array: false });
```

Always instantiate `Encoder` with these flags before encoding SMP payloads, or the device will silently fail to parse.

## DFU flow & slot states (SMP / MCUboot)

The correct, safe sequence with MCUboot rollback protection is:

1. **Upload** to slot 1.
2. **Test** the uploaded image (slot 1 → `pending`).
3. **Reset** the device (expect timeout / disconnect).
4. **Reconnect** after ~5s.
5. **Confirm** the new image in slot 0.

### Slot semantics after each step

| Step | Slot 0 | Slot 1 |
|---|---|---|
| Initial (fresh) | `active + confirmed` | empty |
| After upload + test | `active + confirmed` | `pending` (trailer flag on secondary slot) |
| After reset (swap done) | `active` only — new image, neither pending nor confirmed | old image |
| After confirm | `active + confirmed` (new image) | old image |

**Critical:** if the user disconnects after step 3 (reset) but before step 5 (confirm), the next reboot will revert to the old image. The UI must surface this as "active but unconfirmed — will revert on reboot" (see `checkPending()` in `app.js`).

The MCUboot `pending` trailer flag lives on the *secondary* slot before the swap (meaning "swap me next boot") and is cleared once the swap completes. After the swap, the new primary is `active` but neither `pending` nor `confirmed` — `checkPending()` keys on `active && !confirmed`, not on the `pending` bit, to drive the Confirm Update button.

## Testing

### Test layers

1. **Headless SMP DFU** (`make test`) — fastest, covers the SMP protocol engine + node-ble transport. Does NOT test `bluetooth/connect.js` or the DOM.
2. **Headless Nordic DFU** (`node tools/nordic-dfu-test.mjs <package.zip>`) — covers Nordic Secure DFU protocol engine.
3. **Browser end-to-end** (`make browser-test` or `make browser-test-headless` with `serve.py` running) — exercises the real DOM, Web Bluetooth GATT APIs, and the full UI flow via Puppeteer. The `-headless` variant runs Chrome headed under `xvfb-run` so no display is required (Web Bluetooth itself does not work in true headless Chrome). See `TESTING.md` for prerequisites.

### Verification state

- **SMP / MCUboot**: `make test` **passes** on nRF52840 DK. Device advertises as "Zephyr".
- **Nordic Secure DFU**: `node tools/nordic-dfu-test.mjs <package.zip>` **passes** on nRF52840 DK with Nordic bootloader.

### Firmware setup for SMP testing

Use the `smp_svr` Zephyr sample with `--sysbuild` (builds MCUboot automatically). The firmware in `firmware/` is adapted from this sample.

```bash
# Build v1 baseline + v2 update
make build    # builds firmware/build/ and firmware/build-v2/
# Flash baseline + run headless SMP test
make test     # flash baseline, run dfu-test.mjs with build-v2/zephyr.signed.bin
```

### Nordic test fixtures

Reference bootloader hex and `.zip` packages from nRF5 SDK 17.1.0 are stored under the Nextcloud path (see global rules `ncs-nrfutil.md` for layout).

## Hardware environment notes

This machine has two USB devices that tests depend on:

| Device | Expected `lsusb` ID | Role |
|---|---|---|
| nRF52840 DK (via J-Link) | `1366:1051` SEGGER J-Link | Target firmware device |
| ASUS BT400 BLE dongle | `0b05:17cb` ASUSTek Broadcom BCM20702A0 | BLE adapter for `bluetoothctl` / `node-ble` |

Before running any BLE test (`make test`, `node tools/nordic-dfu-test.mjs`, etc.), verify both are present:

```bash
# Should show 1366:1051 (SEGGER) and 0b05:17cb (ASUS BT400)
lsusb

# Should show a controller entry with Powered: yes
bluetoothctl show
```

If the DK is not in `lsusb`, check the USB cable.
If the BT400 is not in `lsusb` (or `bluetoothctl show` reports `No default controller available`), the Bluetooth service or USB passthrough may need to be restarted.

### User intervention required for Bluetooth restart

This environment runs headless; `sudo` is unavailable. If `hciconfig` / `bluetoothctl` does not show the expected controller, the agent **cannot** self-restore the BLE adapter. The user must fix the Bluetooth USB passthrough / restart `bluetoothd` outside of this session before BLE tests can proceed.

## External rules

Per-repo NCS/Zephyr lookup conventions and Web Bluetooth + SMP protocol rules are stored in global opencode rule files referenced by `opencode.json`:
- `~/.config/opencode/rules/ncs-nrfutil.md`
- `~/.config/opencode/rules/web-bluetooth-smp.md`

Do not duplicate NCS Kconfig/devicetree lookup workflows here — extend the global rules if they need updating.
