# BLE DFU

Browser-based firmware updater for nRF devices over Bluetooth LE.
Supports **SMP / MCUboot** (Zephyr / nRF Connect SDK) and **Nordic Secure DFU**
(nRF5 SDK) protocols with automatic detection.

No installation. No build step. Open the page, pick a file, flash.

---

## Browser support

| Browser | Support |
|---|---|
| Chrome / Edge (desktop, Windows / macOS / Linux) | ✅ |
| Chrome (Android) | ✅ |
| Safari / Firefox / iOS | ❌ — Web Bluetooth not supported |

HTTPS is required (Web Bluetooth restriction). See [Running locally](#running-locally) for options.

---

## Device requirements

### SMP / MCUboot (Zephyr / NCS)

Your firmware must be built with MCUboot and mcumgr BLE transport enabled.
Add to your `prj.conf`:

```kconfig
CONFIG_BOOTLOADER_MCUBOOT=y
CONFIG_MCUMGR=y
CONFIG_MCUMGR_TRANSPORT_BT=y
CONFIG_MCUMGR_GRP_IMG=y
CONFIG_MCUMGR_GRP_OS=y
```

The firmware file to upload is `build/zephyr/zephyr.signed.bin` — the MCUboot-signed binary.

### Nordic Secure DFU (nRF5 SDK)

Requires a bootloader built with Secure DFU. Upload `.zip` packages produced by
nRF Connect / nrfutil (single-application packages first; multi-image is
architected but not yet fully verified).

---

## DFU flow

1. Select your firmware file (`.bin` for SMP, `.zip` for Nordic) — the app validates format before upload
2. Click **Scan & Connect** — browser shows a BLE device picker filtered to supported devices
3. After connecting, the app auto-detects the protocol from the device's advertised services
4. Click **Update Firmware** — the provider runs its protocol-specific sequence:
   - **SMP:** uploads to slot 1 → marks for test → resets → reconnect to confirm
   - **Nordic:** transfers init packet → transfers firmware → device reboots automatically

### SMP chunk size

Default is 128 bytes per SMP packet — safe for all MTU sizes. You can increase
chunk size up to 244 bytes for faster transfers.

| MTU | Chunk | Throughput | 256 KB image |
|---|---|---|---|
| 247 (typical nRF) | 128 B | ~1–2 KB/s | ~2–4 min |
| 247 (typical nRF) | 244 B | ~2–4 KB/s | ~1–2 min |

---

## Running locally

### Option A — Python + Chrome flag (no HTTPS needed)

```bash
python3 -m http.server 8080
```

In Chrome, go to `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, add `http://localhost:8080`, and relaunch Chrome.

### Option B — Any HTTPS static host

Drag the project folder to [Netlify Drop](https://app.netlify.com/drop) or push to GitHub Pages. Both provide HTTPS automatically.

### Option C — Local HTTPS with caddy

```bash
caddy file-server --root . --listen :8080 --access-log
# caddy handles HTTPS automatically on localhost
```

---

## Project structure

```
index.html            — UI (HTML + CSS, no framework)
app.js                — Provider-agnostic UI driver
core/
  events.js           — EventTarget base for providers
  provider.js         — DfuProvider base class + capability contract
  registry.js         — Static table of known providers (UUIDs, file matchers)
  detect.js           — Device + file detection, conflict resolution
bluetooth/
  connect.js          — Generalized Web Bluetooth wrapper (multi-service)
smp/
  cbor.js             — Minimal CBOR encoder/decoder (ported from mcumgr-web)
  mcumgr.js           — SMP protocol engine (transport-decoupled)
  smp-provider.js     — DfuProvider adapter for SMP/MCUboot
nordic/
  secure-dfu.js       — Nordic Secure DFU transfer engine (ported from web-bluetooth-dfu)
  package.js           — .zip parser for Nordic DFU packages
  nordic-provider.js  — DfuProvider adapter for Nordic Secure DFU
vendor/
  jszip.mjs            — Vendored JSZip ESM bundle
  crc-32.js            — Vendored CRC-32 ESM bundle
tools/
  ble-characteristic.mjs — node-ble ↔ Web Bluetooth adapter
  dfu-test.mjs         — Headless SMP DFU test harness (node-ble)
```

**Dependencies at runtime:** none beyond `vendor/`.  
**No build step required.**

---

## SMP / BLE details

| Item | Value |
|---|---|
| GATT Service UUID | `8D53DC1D-1DB7-4CD3-868B-8A527460AA84` |
| GATT Characteristic UUID | `DA2E7828-FBCE-4E01-AE9E-261174997C48` |
| Requests | GATT Write Without Response |
| Responses | GATT Notifications |
| Payload encoding | CBOR |

## Nordic Secure DFU / BLE details

| Item | Value |
|---|---|
| GATT Service UUID | `FE59` (Nordic DFU) |
| Control Point UUID | `8EC90001-F315-4F60-9FB8-838830DAEA50` |
| Packet UUID | `8EC90002-F315-4F60-9FB8-838830DAEA50` |
| Buttonless (no bonds) | `8EC90003-F315-4F60-9FB8-838830DAEA50` |
| Buttonless (with bonds) | `8EC90004-F315-4F60-9FB8-838830DAEA50` |
| Packet writes | GATT Write Without Response |
| Control writes | GATT Write With Response |
| Payload | `.zip` package (init packet + firmware) |

---

## Vendored dependencies

Regenerate with esbuild (dev machine only — not a runtime build step):

```bash
npm install jszip
npx esbuild node_modules/jszip/dist/jszip.min.js --bundle --format=esm --minify --outfile=vendor/jszip.mjs
rm -rf node_modules package*.json
```

```bash
npm install crc-32
# Edit vendor/crc-32.js to export { CRC32 } from a hand-rolled ES module, or
# bundle via esbuild if the package gains a clean ESM entry.
rm -rf node_modules package*.json
```

---

## Testing

See `TESTING.md` for the full build/flash/test loop and manual Chrome verification.
