# web-smp-dfu — project rules

Browser-based MCUboot DFU updater for Zephyr/NCS devices. Vanilla HTML + ES modules, no build step, no runtime npm dependencies.

## Stack constraints

- **Vanilla ES modules**, no framework, no bundler. See `web-bluetooth-smp.md` rule for the rationale.
- **CBOR via `vendor/cbor-x.js`** (vendored, regeneration command in README).
- **Web Bluetooth API** for transport. No serial, no USB, no WebSocket fallback.
- Target browsers: Chrome/Edge desktop and Chrome Android. Don't add Safari/Firefox workarounds — Web Bluetooth isn't supported there.

## Project layout
index.html            — UI (HTML + CSS inline, no framework)
app.js                — UI logic and DFU orchestration
bluetooth/connect.js  — Web Bluetooth connect / disconnect
smp/protocol.js       — SMP frame encoding, CBOR, write queue (SmpClient class)
smp/image.js          — DFU operations: validateImage, listImages, uploadFirmware,
testImage, confirmImage, resetDevice
vendor/cbor-x.js      — vendored CBOR library

When adding new SMP operations, put the wire-level command in `smp/protocol.js` (Op/Group/Cmd constants) and the high-level helper in `smp/image.js` (or a new `smp/<group>.js` if a new group is added).

## Scope

In scope:
- Full upload → test → reset → reconnect → confirm DFU flow on **nRF52840 DK**.
- Per-step status visible in the UI (slot state, progress, rc codes).
- Rollback handling: if user disconnects before confirming, the UI on next connect must reflect "pending — will revert".

Out of scope (don't add unless asked):
- nRF5340 dual-image / net-core DFU.
- Custom file formats (only MCUboot-signed `.bin`).
- Server-side anything — this is fully static.

## Testing the device side

Reference firmware is the `smp_svr` Zephyr sample. See TESTING.md for the exact build commands. Image version is bumped via `CONFIG_MCUBOOT_IMGTOOL_SIGN_VERSION` to verify the swap visually.

# nRF Connect SDK — Knowledge Lookup Rules

The nRF Connect SDK is installed at `~/ncs/`. The exact version directory
varies (e.g. `~/ncs/v2.7.0/`). Resolve it with:
  ls -d ~/ncs/v*/ | sort -V | tail -1

Treat the installed source tree as the authoritative reference. Do NOT
guess at Kconfig symbols, devicetree compatibles, or API signatures —
grep the source. The web docs are a JavaScript SPA and cannot be fetched.

## Kconfig discovery

Every CONFIG_FOO is defined in a `Kconfig*` file with format:
    config FOO
        bool "Short description"
        default n
        depends on BAR
        help
          Multi-line help text explaining the option.

Workflow when you need a Kconfig symbol:
  1. Grep for the symbol definition (NOT just usages):
       grep -rn "^config FOO\b" ~/ncs/v*/nrf ~/ncs/v*/zephyr ~/ncs/v*/modules
  2. View the surrounding Kconfig block to read the help text and deps.
  3. If searching by topic, grep `Kconfig*` files for keywords:
       grep -rn -i "lte modem" ~/ncs/v*/nrf --include="Kconfig*"

When the user has a built project, prefer the resolved config:
  build/zephyr/.config           — final merged config (post-Kconfig)
  build/zephyr/include/generated/zephyr/autoconf.h
These show what is ACTUALLY enabled, vs. what is merely declared.

For interactive exploration of available options for a given app/board:
    west build -t menuconfig
    west build -t guiconfig
Only suggest these to the user; do not run them headlessly.

## Devicetree

Bindings (the "schema" for `compatible = "..."` strings) live in:
  ~/ncs/v*/zephyr/dts/bindings/    — upstream
  ~/ncs/v*/nrf/dts/bindings/       — Nordic-specific
  ~/ncs/v*/modules/**/dts/bindings/ — module-provided

To find a binding by compatible string:
  grep -rln 'compatible: *"nordic,nrf-spim"' ~/ncs/v*/{zephyr,nrf,modules}/dts/bindings

Board DTS files: ~/ncs/v*/{zephyr,nrf}/boards/**/*.dts
SoC-level DTSI:  ~/ncs/v*/{zephyr,nrf}/dts/

For a built project, the merged/resolved devicetree is at:
  build/zephyr/zephyr.dts             — full resolved DT (very useful)
  build/zephyr/include/generated/zephyr/devicetree_generated.h

When suggesting a node, always check the binding's `properties:` block
for required vs. optional fields.

## Headers / APIs

Public Zephyr headers:  ~/ncs/v*/zephyr/include/zephyr/
Public Nordic headers:  ~/ncs/v*/nrf/include/
nrfxlib headers:        ~/ncs/v*/nrfxlib/**/include/
HAL (nrfx):             ~/ncs/v*/modules/hal/nordic/nrfx/

Doxygen comments in the headers are typically more current than the
rendered docs. When asked "how do I use X", grep the header for the
function declaration and read the surrounding /** ... */ block.

## Samples — the best learning resource

  ~/ncs/v*/nrf/samples/        — Nordic samples (start here)
  ~/ncs/v*/nrf/applications/   — fuller reference apps
  ~/ncs/v*/zephyr/samples/     — upstream Zephyr samples

When the user asks "how do I do X", search samples for a working
example before writing one from scratch:
  grep -rln "<api or kconfig>" ~/ncs/v*/nrf/samples ~/ncs/v*/zephyr/samples

Each sample has a `prj.conf`, `sample.yaml`, and often board-specific
overlays in `boards/`. These are concrete, working references.

## Doc sources (RST/MD)

The web docs are unreachable, but their source lives at:
  ~/ncs/v*/nrf/doc/nrf/         — nRF Connect SDK docs source
  ~/ncs/v*/zephyr/doc/          — Zephyr docs source
Grep these as a fallback for conceptual/overview content that isn't
captured in code comments.

## What NOT to do

- Don't fabricate Kconfig symbol names. If you cannot grep it, say so.
- Don't propose a `compatible` string without confirming a binding exists.
- Don't web-search for nRF Connect SDK docs — fetches will fail or
  return empty. Use the local tree.
- Don't suggest API calls without verifying the function exists in a
  header in the local tree.
