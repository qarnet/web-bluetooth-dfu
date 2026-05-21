# web-smp-dfu

Browser-based firmware updater for nRF Connect SDK devices over Bluetooth LE.  
Uses the [Web Bluetooth API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API) and the [SMP / mcumgr](https://docs.zephyrproject.org/latest/services/device_mgmt/smp_protocol.html) protocol.

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

Your firmware must be built with MCUboot and mcumgr BLE transport enabled.  
Add to your `prj.conf`:

```kconfig
CONFIG_BOOTLOADER_MCUBOOT=y
CONFIG_MCUMGR=y
CONFIG_MCUMGR_TRANSPORT_BT=y
CONFIG_MCUMGR_GRP_IMG=y
CONFIG_MCUMGR_GRP_OS=y
```

The firmware file to upload is `build/zephyr/zephyr.signed.bin` — the MCUboot-signed binary produced by the NCS build system.

---

## DFU flow

1. Select your `zephyr.signed.bin` file — the app validates the MCUboot header magic before upload
2. Click **Scan & Connect** — browser shows a BLE device picker filtered to SMP devices
3. After connecting, the app reads the current image slots from the device
4. Click **Flash Firmware** — the app:
   - Uploads the firmware in chunks to slot 1
   - Marks the new image for test (`image test`)
   - Resets the device
   - MCUboot swaps the images and boots the new firmware

Reconnect after reboot to verify the new version in slot 0.

### Chunk size

Default is 128 bytes per SMP packet — safe for all MTU sizes. If your device negotiates a larger MTU (247 bytes is typical for nRF with NCS defaults), you can increase chunk size up to 244 bytes for faster transfers.

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
app.js                — UI logic and DFU orchestration
bluetooth/
  connect.js          — Web Bluetooth connect / disconnect
smp/
  protocol.js         — SMP frame encoding, CBOR, write queue
  image.js            — Image upload, list, test, confirm, reset
vendor/
  cbor-x.js           — Vendored CBOR library (bundled from cbor-x, no npm needed at runtime)
```

**Dependencies at runtime:** none beyond `vendor/cbor-x.js`.  
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

---

## Regenerating vendor/cbor-x.js

Only needed if you want to update the CBOR library version:

```bash
npm install cbor-x
npx esbuild node_modules/cbor-x/index.js --bundle --format=esm --minify --outfile=vendor/cbor-x.js
rm -rf node_modules package*.json
```
