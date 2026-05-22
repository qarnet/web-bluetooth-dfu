# Unified Dual-Protocol BLE DFU Web App

## Context

The repo `web-smp-dfu` implements browser-based BLE firmware update for **one**
protocol only — SMP DFU (MCUmgr / Zephyr / MCUboot) — with its own hand-written
`smp/protocol.js` + `smp/image.js`. Meanwhile, mature open-source web
implementations of **both** protocols we care about already exist on disk:

- **SMP DFU** — `boogie/mcumgr-web` at
  `/mnt/c/Users/thomas-win/Nextcloud/Web-Bluetooth-Resources/nrf-connect-sdk-dfu/mcumgr-web-main/`
  (vanilla JS, standalone `cbor.js`, Jest-tested).
- **nRF5 SDK "Secure DFU"** — `thegecko/web-bluetooth-dfu` at
  `/mnt/c/Users/thomas-win/Nextcloud/Web-Bluetooth-Resources/nrf5sdk-dfu/web-bluetooth-dfu-master/`
  (TypeScript, `.zip` package format, jszip + crc-32).

We are reinventing the wheel. The goal is **one** website that updates devices
running **either** protocol, with the protocol detected automatically (no
user-facing protocol picker), built on the proven external code rather than
bespoke implementations.

## Authoritative references on disk

In addition to the two reference web implementations above, the following
sources are local and treated as ground truth:

- **nRF5 SDK 17.1.0** —
  `/mnt/c/Users/thomas-win/Nextcloud/Web-Bluetooth-Resources/nrf5SDK/nRF5_SDK_17.1.0_ddde560/`
  - `components/ble/ble_services/ble_dfu/ble_dfu.{c,h}` — application-side
    buttonless service. Confirms: service UUID `0xFE59`, buttonless 16-bit
    char IDs `0x0003` (unbonded) and `0x0004` (bonded) over Nordic vendor
    base UUID `8e:c9:00:00…50` — matches the plan's UUIDs exactly.
  - `components/libraries/bootloader/ble_dfu/nrf_dfu_ble.c` — bootloader-side
    GATT layout, MTU negotiation, advertising. Bootloader advertises with
    name `NRF_DFU_BLE_ADV_NAME` (default `"DfuTarg"`) — useable as a
    `namePrefix` filter alongside the FE59 service UUID.
  - `components/libraries/bootloader/dfu/dfu-cc.proto` — init-packet
    protobuf schema. Informational only: the Web DFU engine writes the
    init-packet `.dat` file from the `.zip` as **opaque bytes** to the
    Control Point; no protobuf decoder needed in the browser.
  - `examples/dfu/secure_dfu_test_images/ble/nrf52840/` — **pre-built test
    fixtures**, used directly as our test corpus (see Verification):
    - `hrs_application_s140.zip` — single-app package
    - `softdevice_s140.zip` — softdevice-only
    - `bootloader_secure_ble_debug_{with,without}_bonds_s140.zip` — BL-only
    - `ble_app_buttonless_dfu_{with,without}_bonds_s140.zip` — buttonless app
    - `sd_s140_bootloader_buttonless_with_setting_page_dfu_secure_ble_debug_{with,without}_bonds.hex`
      — flashable baseline. **Programming this onto the nRF52840 DK turns
      the same board into a Nordic Secure DFU target**, eliminating the
      need for a second physical device.
- **nRF5 SoftDevice releases** —
  `/mnt/c/Users/thomas-win/Nextcloud/Web-Bluetooth-Resources/nrf5SDK/s{112,113,122,132,140}nrf52{720,800}/`
  — `.hex` images for SD upgrade testing if/when multi-image is verified.
- **WebBluetoothCG/registries** —
  `.../general-web-bluetooth/registries-master/gatt_blocklist.txt`. Confirms
  SMP `8d53dc1d-…` and Secure DFU `0xFE59` are **not** blocklisted, while
  **Nordic Legacy DFU `00001530-1212-efde-1523-785feabcd123` is
  blocklisted** by Chrome (and policy supports low-latency additions). Legacy
  DFU is therefore hard out-of-scope at the API layer, not just by design.
- **WebBluetoothCG/web-bluetooth** —
  `.../general-web-bluetooth/web-bluetooth-main/implementation-status.md`.
  Relevant constraints:
  - `writeValueWithResponse` / `writeValueWithoutResponse` are the canonical
    APIs from Chrome 85+ (the plain `writeValue` overload is deprecated).
    Nordic Control Point = with-response; Nordic Packet = without-response;
    SMP characteristic = without-response. The connect/IO layer must use
    the explicit variants, not the deprecated overload.
  - Some GATT operations cannot run in parallel — both engines already
    serialize, but the shared connect layer must not introduce concurrent
    GATT calls.
  - `getDevices()` and Persistent Device Permissions are flag-gated. We
    therefore cannot transparently re-acquire the device across a
    buttonless reboot: the buttonless flow must surface a "Reconnect"
    button and the user clicks through `requestDevice` a second time.
  - Web Bluetooth is Chrome/Edge/Samsung-Internet/Opera only. Firefox and
    Safari are not implemented; iOS users need Bluefy/WebBLE. Document in
    README, do not engineer around it.
- **WebBluetoothCG/manual-tests** —
  `.../general-web-bluetooth/manual-tests-main/`. Reference patterns for
  `characteristic_readwrite`, `characteristic_notify`, `cancel_gatt_connect`.

**Decisions made with the user:**
1. The SMP engine will be **replaced** with `mcumgr-web`'s code (not the repo's
   current `smp/protocol.js`/`image.js`). Accepted tradeoff: the existing headless
   harness loses its target and must be rewritten and re-verified on hardware.
2. **SMP chunking/MTU:** Use the `mcumgr-web` implementation for payload sizing
   and timeout/retry logic. The UI chunk-size input (if kept) maps to the
   provider's internal `_mtu` rather than the current manual BLE-write fragmenting.
   Default `_mtu` is capped to a safe BLE value (≤244 bytes total frame).
3. **Buttonless DFU** (app firmware → reboot into bootloader → reconnect) is
   **in scope**. Support both standard buttonless characteristics:
   `8ec90003-f315-4f60-9fb8-838830daea50` (without bonds) and
   `8ec90004-f315-4f60-9fb8-838830daea50` (with bonds).
4. **Nordic multi-image `.zip`:** First iteration targets **single-application**
   packages only. Multi-image packages (softdevice, bootloader, combinations) are
   in scope but deferred after the single-image path is verified end-to-end.
5. **Pre-upload `.bin` metadata:** Rich MCUboot metadata display (version, hash,
   protected TLVs, tags) is a desired follow-up feature — not first-to-implement,
   but the ported `mcumgr.js` already contains the `imageInfo()` parser so the
   adapter can expose it later without structural changes.
6. **Hardware available:** An nRF52840 DK and an ASUS USB-BT500 dongle for
   headless BLE access. The same DK serves as **both** the SMP target (current
   Zephyr `smp_svr` build) and — by re-flashing one of the SDK 17.1.0
   `sd_s140_bootloader_buttonless_with_setting_page_dfu_secure_ble_debug_*.hex`
   baselines — the Nordic Secure DFU target. `make test` gates SMP work;
   Nordic verification is both headless (`nordic-dfu-test.mjs`) and manual
   Chrome, using the SDK-shipped `.zip`s as the test corpus.
7. **Legacy nRF5 DFU (`0x1530` service) is hard out-of-scope.** Chrome's GATT
   blocklist forbids it; the registry policy allows fast blocklist updates,
   so even a workaround would be brittle. The registry and detection layer
   must reject `00001530-1212-efde-1523-785feabcd123` explicitly with a
   message pointing users at a Secure DFU bootloader upgrade.
8. **Write API:** all characteristic writes use the explicit
   `writeValueWithResponse` / `writeValueWithoutResponse` (Chrome 85+).
   The deprecated `writeValue` overload is never called. Wired per-char:
   Nordic Control Point = with-response, Nordic Packet = without-response,
   SMP characteristic = without-response.

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
- `requestDevice` with `filters` = OR-union of every registry service UUID
  **plus** a `{namePrefix: "DfuTarg"}` filter for the Nordic bootloader (it
  advertises FE59 *and* the name `DfuTarg`; the dual filter survives stacks
  that under-report service UUIDs in advertisements). `optionalServices` =
  the **same full UUID union** — any service touched by `getPrimaryService`
  must be declared up front.
- after `gatt.connect()`, call `getPrimaryServices()`; match UUIDs to registry.
- SMP service `8d53dc1d-…` -> SMP.
- Nordic service `0000fe59-…` present -> Nordic. Then inspect its characteristics:
  - Control Point `8ec90001-…` present -> **bootloader mode**, ready to transfer.
  - only Buttonless `8ec90003-…` (or with-bonds variant) -> **app mode**, must
    trigger the buttonless reboot first (see Nordic provider below).
- Blocklist guard: if `00001530-1212-efde-1523-785feabcd123` appears in the
  service list, hard-stop with a Legacy-DFU-not-supported message. (Chrome
  will refuse access anyway, but the message has to be ours, not a generic
  SecurityError.)

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
  **Chunking:** port `mcumgr-web`'s MTU-based payload sizing and timeout/retry
  logic. Default `_mtu` capped to ≤244 for safe BLE transport; configurable.
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
  `softdevice_bootloader`). Each image entry pairs a `.dat` (the protobuf-
  encoded init packet — opaque to us, written as bytes to the Control Point
  during `transferInit`) with a `.bin` (the firmware payload streamed over
  the Packet characteristic). The protobuf schema lives in `dfu-cc.proto`
  for human reference; we do not link a protobuf library. Nordic `.bin`s
  carry no self-magic, so file-level validation is *structural* (zip +
  manifest + referenced `.dat`/`.bin` files exist); content CRC is checked
  *during* transfer against device-reported checksums.
- **`nordic/nordic-provider.js`** — adapter implementing `DfuProvider`:
  capabilities all-false except `multiObject`;
  `readState` -> `[]`;
  `loadFirmware` -> parse package, expose parts;
  `runUpdate` loops over manifest images, each `transferInit` then
  `transferFirmware`, emitting `phase` (`create`/`transfer`/`crc`/`execute`);
  a multi-image package (softdevice+bootloader+app) means **multiple sequential
  runs, each with its own reboot** — the loop and the UI must survive that.
  **Scope:** single-application `.zip` first; multi-image loop is architected
  for now but not verified until the single-image path is green.

**Buttonless flow** — when detection finds FE59 in *app mode* (only the
buttonless characteristic): the provider writes the buttonless command, the
device disconnects and reboots into the bootloader (re-advertising FE59 with a
changed BLE address), the provider emits `needs-reconnect`, and `app.js` prompts
the user to click Connect again. The second connect lands on the bootloader's
FE59 and the real transfer begins.
  - Supports both `8ec90003…` (buttonless without bonds) and `8ec90004…`
    (buttonless with bonds).
  - Reconnect is **always a fresh `requestDevice` prompt**: Chrome's
    `getDevices()` + Persistent Device Permissions are flag-gated, so we
    cannot silently re-acquire the device by its prior identifier. The UI
    must make the second click explicit ("Device rebooted — click Reconnect").
  - Legacy custom trigger-service UUIDs are out of scope unless added to the
    registry later.

**MTU / chunk size:** the SDK 17.1.0 bootloader negotiates ATT MTU up to
`NRF_SDH_BLE_GATT_MAX_MTU_SIZE` (typically 247), but Web Bluetooth does not
expose the negotiated MTU. The ported engine therefore keeps the upstream
default Packet chunk size (≤20 bytes payload, the BLE-default-MTU floor).
This is slower than native nRF Connect but is the only portable choice; do
not "optimize" it without a way to query the real MTU.

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
2. **GATT blocklist drift** — Chrome can add UUIDs at any time
   (`gatt_blocklist_policy.md` is explicit about low-latency updates). Today
   FE59 and the SMP service are clear; if either is ever blocklisted, the app
   stops working with no code change on our side. Document and accept; no
   mitigation possible.
3. **Buttonless reboot** is a two-connection user flow with a device reboot,
   BLE-address change, and a *mandatory* fresh `requestDevice` prompt
   (Persistent Permissions are flag-gated). UI must explain it clearly. Both
   buttonless-variants (`03` and `04`) must be handled.
4. **Multi-image Nordic packages** = multiple sequential DFU runs, each with its
   own reboot/reconnect. **Architected for now, verified later** (single-image
   first). SoftDevice upgrades are higher-risk because a failure mid-SD-flash
   bricks the device until reprogrammed over SWD.
5. **Harness regression** — replacing the SMP engine invalidates the current
   harness; rewrite + hardware re-verify before moving on.
6. **mcumgr-web `cbor.js` / `mcumgr.js` are not ES modules** — porting must add
   exports and strip the built-in device picker without changing framing logic.
7. **MTU is invisible to Web Bluetooth** — we keep the engine's 20-byte
   default. Throughput will be visibly slower than native nRF Connect; note in
   README so users do not raise it as a bug.
8. **Nordic hardware** — verifying the Nordic path is now low-risk: the
   nRF52840 DK can be re-flashed with a SDK 17.1.0
   `bootloader_secure_..._with_setting_page_...hex` baseline to become a
   Nordic Secure DFU target, and the SDK ships matching `.zip` payloads.

## Ordered implementation steps

1. Vendor `vendor/jszip.js` + `vendor/crc-32.js`; document regeneration.
2. `core/events.js` — thin `EventTarget` extension (native in browser and Node 18+).
3. `core/provider.js` — `DfuProvider` base + capability contract.
4. `core/registry.js` — static provider table.
5. Generalize `bluetooth/connect.js` — multi-service `requestDevice` (union of
   service filters + `namePrefix:"DfuTarg"`), explicit
   `writeValueWith{,out}Response` wrappers, Legacy-DFU UUID guard, return
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

Test corpus is the SDK 17.1.0 bundle at
`.../nrf5SDK/nRF5_SDK_17.1.0_ddde560/examples/dfu/secure_dfu_test_images/ble/nrf52840/`.
All filenames below are from that directory.

- **SMP regression (first):** `make test` on the nRF52840 DK — rewritten
  `dfu-test.mjs` passes exit 0; negative test (baseline `.bin`) exits non-zero.
- **SMP browser:** Chrome manual per `TESTING.md` — pick `.bin`, connect, flash,
  confirm; slot UI works; protocol badge shows "SMP".
- **Nordic structural (no hardware):** feed each of `hrs_application_s140.zip`,
  `softdevice_s140.zip`, `bootloader_secure_ble_debug_without_bonds_s140.zip`,
  `ble_app_buttonless_dfu_without_bonds_s140.zip`, and at least one
  `softdevice_bootloader` package to `nordic/package.js`; assert each
  manifest variant + referenced `.dat`/`.bin` parts parse.
- **Nordic bootloader-mode (headless):** flash the DK with
  `bootloader_secure_ble_debug_without_bonds_s140.hex`, hold the trigger so
  it boots into FE59; run `tools/nordic-dfu-test.mjs` against
  `hrs_application_s140.zip` over the USB-BT500 dongle.
- **Nordic buttonless (Chrome manual):** flash the DK with
  `sd_s140_bootloader_buttonless_with_setting_page_dfu_secure_ble_debug_without_bonds.hex`;
  open the app, pick `ble_app_buttonless_dfu_without_bonds_s140.zip`,
  connect (lands on app-mode FE59 with only buttonless char), confirm the
  app issues the buttonless command, the device reboots, the
  `needs-reconnect` UI appears, and a second Connect completes the transfer.
- **Nordic bonded variant (Chrome manual):** repeat with the
  `with_bonds` `.hex` + `with_bonds` `.zip` to exercise the `8ec90004…`
  characteristic path.
- **Legacy DFU rejection (Chrome manual):** any device advertising
  `00001530-…` (or a mock thereof) must produce the hard-stop message, never
  a generic SecurityError.
- **Detection matrix:** Chrome manual — every combination of file/device signal,
  especially both conflict cases (must hard-stop with the right message) and the
  buttonless app-mode case.
- **Browser support note:** all verification is Chrome/Edge. Firefox/Safari
  are out of scope (no Web Bluetooth); document, do not test.
