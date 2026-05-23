# web-smp-dfu — agent guidance

Browser-based MCUboot DFU updater for Zephyr/NCS devices. Vanilla HTML + ES modules, no build step, no runtime npm dependencies.

## Architecture constraints

- **No build step.** The browser loads modules directly. Do not add a bundler (webpack, Vite, esbuild), transpiler, or framework (React, Vue, Svelte).
- **No runtime npm dependencies.** If a library is needed, vendor it as a single ES module in `vendor/`. The current CBOR library (`vendor/cbor-x.js`) was generated with `esbuild` from `cbor-x` — see README for the exact command.
- **HTTPS or localhost only.** Web Bluetooth requires a secure context. The README documents the Chrome flag for local HTTP (`unsafely-treat-insecure-origin-as-secure`).

## CBOR gotcha

The MCUboot `zcbor` decoder on the device rejects cbor-x's default "records" tag and tagged `Uint8Array`s.

```js
const cbor = new Encoder({ useRecords: false, tagUint8Array: false });
```

Always instantiate `Encoder` with these flags before encoding SMP payloads, or the device will silently fail to parse.

## Project layout

| File | Responsibility |
|---|---|
| `index.html` | DOM, inline CSS, no framework |
| `app.js` | UI orchestration and DFU state machine |
| `bluetooth/connect.js` | `navigator.bluetooth` device picker, GATT connect/disconnect |
| `smp/protocol.js` | `SmpClient` — SMP header encoding, CBOR, notification parsing, **write queue** |
| `smp/image.js` | High-level DFU ops: `validateImage`, `listImages`, `uploadFirmware`, `testImage`, `confirmImage`, `resetDevice` |
| `vendor/cbor-x.js` | Vendored CBOR library only |

**Rule for new SMP operations:** wire-level constants (Op/Group/Cmd IDs) go in `smp/protocol.js`; high-level helpers go in `smp/image.js` (or `smp/<group>.js` if adding a new group).

## SMP protocol quirks

- **Header:** 8 bytes big-endian: `Op(1) | Flags(1) | Length(2) | Group(2) | Seq(1) | Cmd(1)`.
- **Transport:** GATT Write Without Response for requests, GATT Notifications for responses. UUIDs are in `bluetooth/connect.js`.
- **Queued writes:** `writeValueWithoutResponse` throws if called while another is in flight. `SmpClient` handles this internally via `#enqueue` — direct access to the characteristic should not be needed.
- **Timeout:** `SmpClient.send()` times out after 30s. The **reset command is expected to timeout** because the device disconnects immediately; callers should catch and ignore the timeout (see `resetDevice()` implementation).
- **Seq tracking:** `seq` is an auto-incrementing `& 0xff` byte used to match requests with notifications.

## DFU flow & slot states

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
| After upload + test | `active + confirmed` | `pending` |
| After reset (swap done) | `active + pending` (new image) | old image |
| After confirm | `active + confirmed` (new image) | old image |

**Critical:** if the user disconnects after step 3 (reset) but before step 5 (confirm), the next reboot will revert to the old image. The UI must surface this as "pending — will revert on reboot" (see `checkPending()` in `app.js`).

## Testing

- **Headless harness** (`tools/dfu-test.mjs`): reuses `smp/protocol.js` and `smp/image.js` to run the full DFU over real BLE from Node.js (uses `node-ble`). It does **not** test `bluetooth/connect.js` or the DOM. See `TESTING.md` for the full build/flash/test loop.
- **Manual full-stack test:** requires Chrome + an nRF52840 DK running the `smp_svr` Zephyr sample with `--sysbuild` (builds MCUboot automatically). See `TESTING.md` for exact `west` commands.

## External rules

Per-repo NCS/Zephyr lookup conventions and Web Bluetooth + SMP protocol rules are stored in global opencode rule files referenced by `opencode.json`:
- `~/.config/opencode/rules/ncs-nrfutil.md`
- `~/.config/opencode/rules/web-bluetooth-smp.md`

Do not duplicate NCS Kconfig/devicetree lookup workflows here — extend the global rules if they need updating.
