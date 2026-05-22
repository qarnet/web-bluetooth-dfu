Here is a draft plan to refine:

# Unified Dual-Protocol BLE DFU Web App

## Context

The repo `web-smp-dfu` implements browser-based BLE firmware update for **one**
protocol only — SMP DFU (MCUmgr / Zephyr / MCUboot) — with its own hand-written
`smp/protocol.js` + `smp/image.js`. Meanwhile, mature open-source web
implementations of **both** protocols we care about already exist on disk:

- **SMP DFU** — `boogie/mcumgr-web` at
  `/mnt/c/Users/thomas-win/Nextcloud/Projects/nrf-connect-sdk-dfu/mcumgr-web-main/`
  (vanilla JS, standalone `cbor.js`, Jest-tested).
- **nRF5 SDK legacy "Secure DFU"** — `thegecko/web-bluetooth-dfu` at
  `/mnt/c/Users/thomas-win/Nextcloud/Projects/nrf5sdk-dfu/web-bluetooth-dfu-master/`
  (TypeScript, `.zip` package format, jszip + crc-32).

We are reinventing the wheel. The goal is **one** website that updates devices
running **either** protocol, with the protocol detected automatically (no
user-facing protocol picker), built on the proven external code rather than
bespoke implementations.

**Decisions made with the user:**
- The SMP engine will be **replaced** with `mcumgr-web`'s code (not the repo's
  current `smp/protocol.js`/`image.js`). Accepted tradeoff: the existing headless
  harness loses its target and must be rewritten and re-verified on hardware.
- **Buttonless DFU** (app firmware → reboot into bootloader → reconnect) is
  **in scope**.

## Goal

A static, no-build-step, no-runtime-dependency web app where SMP and Nordic
Secure DFU are interchangeable plugins behind a common `DfuProvider` interface.
Detection combines the device's advertised GATT service with the picked
firmware file type. UI adapts to whichever provider is active, staying one page.

## Architecture: pluggable providers

`app.js` becomes a generic driver that talks only to a `DfuProvider`. Each
protocol is one provider. A shared connect layer + registry + detection sit
above both. The two protocol engines stay fully independent (different framing,
different GATT layout, different notification models) — only the *interface*,
the *connect layer*, and the *file/device detection* are shared.

### Directory structure

```
index.html                  protocol-aware UI (CSS stays inline)
app.js                       provider-agnostic UI driver
core/
  events.js                  EventTarget-based emitter base
  provider.js                DfuProvider base class + capability contract (JSDoc)
  registry.js                static table of known providers (UUIDs, file matchers)
  detect.js                  device-side + file-side detection, conflict resolution
bluetooth/
  connect.js                 GENERALIZED Web Bluetooth wrapper (multi-service)
smp/
  cbor.js                    ported from mcumgr-web js/cbor.js -> ES module
  mcumgr.js                  ported from mcumgr-web js/mcumgr.js -> ESM, transport-decoupled
  smp-provider.js            adapter implementing DfuProvider
nordic/
  secure-dfu.js              ported from web-bluetooth-dfu src/secure-dfu.ts -> vanilla JS
  package.js                 ported from web-bluetooth-dfu examples/package.js (.zip parser)
  nordic-provider.js         adapter implementing DfuProvider (incl. buttonless)
vendor/
  jszip.js                   NEW vendored pre-built ESM bundle
  crc-32.js                  NEW vendored pre-built ESM bundle
tools/
  ble-characteristic.mjs     extended: 2 characteristics + write-with-response
  dfu-test.mjs               REWRITTEN to drive SmpProvider over node-ble
  nordic-dfu-test.mjs        OPTIONAL new headless Nordic harness
firmware/                    unchanged (device-side Zephyr smp_svr)
```

**Removed:** `smp/protocol.js`, `smp/image.js`, `vendor/cbor-x.js` — replaced by
the mcumgr-web port, which ships its own CBOR.

## The DfuProvider interface (`core/provider.js`)

A provider is a stateful object owning one DFU session, created *after* a BLE
connection exists. Base class wires an `EventTarget` (`core/events.js`).

**Capabilities** (static, drive the UI):
```
id                 "smp" | "nordic"
label              "SMP / MCUboot" | "Nordic Secure DFU"
capabilities = {
  hasSlots:          bool   SMP true,  Nordic false
  hasConfirmStep:    bool   SMP true,  Nordic false
  hasTestStep:       bool   SMP true,  Nordic false
  chunkConfigurable: bool   SMP true,  Nordic false (fixed 20-byte packets)
  multiObject:       bool   SMP false, Nordic true  (init packet + image)
}
```

**Lifecycle methods** (all async, may throw):
```
attach(session)      resolve characteristics from session.services, start notifications
readState()          -> Array<SlotDescriptor>  (SMP: real slots; Nordic: [])
loadFirmware(file)   validate + parse a File; throws human message if wrong type
runUpdate()          run the full protocol-specific sequence; emits events throughout
confirm()            SMP only: finalize pending swap after reconnect
detach()             stop notifications, drop listeners (does NOT disconnect GATT)
```

**Events** (`addEventListener`):
```
'log'             { message, level }   level: info|ok|warn|error
'progress'        { phase, currentBytes, totalBytes }
'phase'           { phase, label }     e.g. upload|test|reset|execute|confirm
'needs-reconnect' {}                   device rebooted; app prompts user to reconnect
```

`runUpdate()` is intentionally coarse: each provider runs its own step sequence
internally and reports via `phase`/`progress` events, so `app.js` never learns
the protocol shape. The event model is chosen because Nordic's `secure-dfu.ts`
already emits `log`/`progress` events; the SMP adapter just translates
mcumgr-web's progress callbacks into the same events.

## Automatic detection (`core/detect.js`)

Two independent signals; the user may supply them in either order.

**File-side** — on file pick, read first 8 bytes:
- LE uint32 `== 0x96f3b83d` (MCUboot magic) -> **SMP** candidate.
- bytes `50 4B 03 04` (`PK\x03\x04`, ZIP magic) -> **Nordic** candidate.
- neither -> unknown (do not hard-fail; device signal may still arrive).

**Device-side** — `bluetooth/connect.js`:
- `requestDevice` with `filters` = OR-union of every registry service UUID, and
  `optionalServices` = the **same full union** (required: any service touched by
  `getPrimaryService` must be declared up front).
- after `gatt.connect()`, call `getPrimaryServices()`; match UUIDs to registry.
- SMP service `8d53dc1d-…` -> SMP.
- Nordic service `0000fe59-…` present -> Nordic. Then inspect its characteristics:
  - Control Point `8ec90001-…` present -> **bootloader mode**, ready to transfer.
  - only Buttonless `8ec90003-…` (or with-bonds variant) -> **app mode**, must
    trigger the buttonless reboot first (see Nordic provider below).

**Combination rule:** the device signal is authoritative when present (cannot
flash a protocol the device does not speak); the file signal pre-arms the UI
before connection. A device/file mismatch (e.g. `.bin` file + Nordic device) is
a **hard stop** with a precise message — never silently pick one.

## SMP provider (`smp/` — ported from mcumgr-web)

- **`smp/cbor.js`** — port mcumgr-web `js/cbor.js` to a clean ES module
  (`export` the encoder/decoder). Replaces the vendored `cbor-x`.
- **`smp/mcumgr.js`** — port mcumgr-web `js/mcumgr.js` (`MCUManager`) to an ES
  module, **decoupling transport**: the constructor/`attach` takes an
  already-connected GATT characteristic instead of doing its own
  `navigator.bluetooth` picker. This both fits the shared connect layer and
  makes the headless harness possible. Same SMP service/char UUIDs as today.
- **`smp/smp-provider.js`** — adapter implementing `DfuProvider`:
  `attach` builds the `MCUManager` over `session`'s SMP characteristic;
  `readState` -> image-state list -> `SlotDescriptor[]`;
  `loadFirmware` validates MCUboot magic;
  `runUpdate` runs upload -> mark-test -> reset, emitting `phase`/`progress`,
  returns `{needsConfirm:true}` and emits `needs-reconnect`;
  `confirm` runs image-confirm after reconnect.

## Nordic provider (`nordic/` — ported from web-bluetooth-dfu)

The engine is **ported** to vanilla JS (not vendored as a built bundle): the
repo forbids a build step, `secure-dfu.ts` is ~600 lines of thin TypeScript
(types only — mechanical to strip), and no `dist/` bundle exists in the
reference checkout. Hand-porting also lets us drop the `events` dependency
(use `core/events.js`) and the engine's own device-picker (the shared connect
layer owns connection).

- **`nordic/secure-dfu.js`** — ported transfer engine: `OPERATIONS`/`RESPONSE`/
  `EXTENDED_ERROR` tables, `handleNotification`, `sendOperation`/`sendControl`,
  `transferInit`/`transferFirmware`/`transferObject`/`transferData`, `checkCrc`.
  `crc32` is imported from `vendor/crc-32.js`. **Preserve faithfully** the
  retry-the-whole-update-with-delay behavior — Nordic Packet writes are
  timing-sensitive on some BLE stacks.
- **`nordic/package.js`** — ported `.zip` parser over `vendor/jszip.js`:
  `loadPackage(arrayBuffer)` -> `{manifest, getImages()}`. Must handle all
  manifest variants (`application`, `softdevice`, `bootloader`,
  `softdevice_bootloader`). Nordic `.bin`s carry no self-magic, so validation
  is *structural* (zip + manifest + referenced files exist); content CRC is
  checked *during* transfer against device-reported checksums.
- **`nordic/nordic-provider.js`** — adapter implementing `DfuProvider`:
  capabilities all-false except `multiObject`;
  `readState` -> `[]`;
  `loadFirmware` -> parse package, expose parts;
  `runUpdate` loops over manifest images, each `transferInit` then
  `transferFirmware`, emitting `phase` (`create`/`transfer`/`crc`/`execute`);
  a multi-image package (softdevice+bootloader+app) means **multiple sequential
  runs, each with its own reboot** — the loop and the UI must survive that.

**Buttonless flow** — when detection finds FE59 in *app mode* (only the
buttonless characteristic): the provider writes the buttonless command, the
device disconnects and reboots into the bootloader (re-advertising FE59 with a
changed BLE address), the provider emits `needs-reconnect`, and `app.js` prompts
the user to click Connect again. The second connect lands on the bootloader's
FE59 and the real transfer begins. (Modern buttonless exposes FE59 directly;
legacy custom trigger-service UUIDs are out of scope unless added to the
registry later.)

## Vendored dependencies

`vendor/jszip.js` and `vendor/crc-32.js` — bundle once on a dev machine
(`npm install <pkg> && npx esbuild … --format=esm --bundle --minify`), check the
output in, then `rm -rf node_modules package*.json`. Same pattern the README
already documents for `cbor-x`. Document regeneration for the new bundles;
remove the `cbor-x` section (that dep is gone).

## UI (`index.html` + `app.js`)

Stays one page, dark inline-CSS, no framework. UI is **capability-driven**, not
a protocol switch the user sees.

- File `accept` starts `.bin,.zip`; narrows once a provider is known.
- New informational `#protocol-badge` shows "SMP / MCUboot" or
  "Nordic Secure DFU" after detection — the user never chooses.
- `capabilities.hasSlots === false` -> hide `#slots` + "Refresh slots".
- `capabilities.hasConfirmStep === false` -> never show `#btn-confirm`.
- `capabilities.chunkConfigurable === false` -> hide the chunk-size row.
- `#btn-dfu` label is generic ("Update Firmware"); its text during a run follows
  `phase` events.
- Progress bar fed identically by `progress` events for both providers.
- `app.js`'s `log()` subscribes to the provider's `'log'` event instead of
  being called inline.
- `app.js` is restructured into: file-pick handler (`detect.detectFromFile` +
  `provider.loadFirmware`), connect handler (shared connect + `detect.resolve` +
  `provider.attach`), update handler (`provider.runUpdate()`), confirm handler
  (`provider.confirm()`). All current inline SMP sequencing moves into
  `smp-provider.js`.

## Headless test harness

- **`tools/dfu-test.mjs`** is **rewritten** to drive the new `SmpProvider` (over
  `MCUManager`) using the node-ble `BleCharacteristic` adapter — this is forced
  by replacing the SMP engine. Re-verifying it green on the nRF52840 DK is a
  hard gate before the SMP work is considered done.
- **`tools/ble-characteristic.mjs`** is extended: Nordic needs **two**
  characteristics and both `writeValue` (write-with-response, Control Point) and
  `writeValueWithoutResponse` (Packet).
- **`tools/nordic-dfu-test.mjs`** (optional) covers the **non-buttonless** path
  (device already in FE59 bootloader) headless via node-ble; jszip runs fine in
  Node. The buttonless reboot path is manual Chrome verification only.

## Risks / trickiest parts

1. **`optionalServices` must list every UUID up front** — you cannot reach a
   service discovered later. The registry forces the connect layer to pass the
   full union every time. Highest-risk constraint.
2. **Buttonless reboot** is a two-connection user flow with a device reboot and
   BLE-address change mid-update — the UI must explain it clearly.
3. **Multi-image Nordic packages** = multiple sequential DFU runs, each with its
   own reboot/reconnect.
4. **Harness regression** — replacing the SMP engine invalidates the current
   harness; rewrite + hardware re-verify before moving on.
5. **mcumgr-web `cbor.js` / `mcumgr.js` are not ES modules** — porting must add
   exports and strip the built-in device picker without changing framing logic.
6. **Nordic hardware** — verifying the Nordic path needs an nRF51/nRF52 flashed
   with an nRF5-SDK Secure DFU bootloader, different from the nRF52840 DK +
   `smp_svr` used today. Sample `.zip`s exist in the reference repo's `firmware/`.

## Ordered implementation steps

1. Vendor `vendor/jszip.js` + `vendor/crc-32.js`; document regeneration.
2. `core/events.js` — EventTarget emitter base.
3. `core/provider.js` — `DfuProvider` base + capability contract.
4. `core/registry.js` — static provider table.
5. Generalize `bluetooth/connect.js` — multi-service `requestDevice`, return
   `{device, server, services}`.
6. Port mcumgr-web -> `smp/cbor.js` + `smp/mcumgr.js` (transport-decoupled).
7. `smp/smp-provider.js` adapter. Remove `smp/protocol.js`, `smp/image.js`,
   `vendor/cbor-x.js`.
8. Rewrite `tools/dfu-test.mjs` for `SmpProvider`; **run `make test` on the
   nRF52840 DK — must pass exit 0. Gates everything after.**
9. Port `nordic/secure-dfu.js` from `secure-dfu.ts` (strip types, use
   `core/events.js` + `vendor/crc-32.js`, drop device picker).
10. Port `nordic/package.js` from `examples/package.js`.
11. `nordic/nordic-provider.js` adapter, including the buttonless flow.
12. `core/detect.js` — file + device detection + conflict resolution.
13. Rewrite `app.js` as the provider-agnostic, capability-gated driver.
14. Update `index.html` — generic header, `accept=".bin,.zip"`, protocol badge,
    hideable slot section.
15. Optional `tools/nordic-dfu-test.mjs` + extend `tools/ble-characteristic.mjs`.
16. Update `README.md`, `STATUS.md`, `TESTING.md`, `AGENTS.md` (project layout,
    provider abstraction, new vendored deps).

## Verification

- **SMP regression (first):** `make test` on the nRF52840 DK — rewritten
  `dfu-test.mjs` passes exit 0; negative test (baseline `.bin`) exits non-zero.
- **SMP browser:** Chrome manual per `TESTING.md` — pick `.bin`, connect, flash,
  confirm; slot UI works; protocol badge shows "SMP".
- **Nordic structural:** feed a sample `.zip` from the reference repo's
  `firmware/` to `nordic/package.js`; assert manifest + parts parse.
- **Nordic non-buttonless:** device flashed with an nRF5-SDK Secure DFU
  bootloader (boots into FE59); run `tools/nordic-dfu-test.mjs` or Chrome manual.
- **Nordic buttonless:** Chrome manual — verify reboot + reconnect-prompt flow.
- **Detection matrix:** Chrome manual — every combination of file/device signal,
  especially both conflict cases (must hard-stop with the right message) and the
  buttonless app-mode case.
