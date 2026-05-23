# Testing Guide

## What you need

- nRF52840 DK (`PCA10056`) — recommended, most RAM headroom
- NCS workspace (`west init`'d, `west update`'d)
- Chrome desktop or Android Chrome (for the manual full-stack check)

---

## Automated harness (headless, no browser)

`tools/dfu-test.mjs` runs the full SMP DFU over real BLE and reuses the app's own
`smp/smp-provider.js` + `smp/mcumgr.js` — so it tests the shipped protocol code, not
a reimplementation. It does **not** cover `bluetooth/connect.js` or the DOM;
use the manual Chrome steps below for those.

One-time setup (BLE stack + harness deps) is in `STATUS.md`. Then:

```bash
make build    # B — west builds v1 baseline + v2 update image
make test     # C+D — flash baseline, run the DFU harness
make dfu      # B+C+D — full loop after a code change
```

The harness exits 0 on success. Override the target with `DEVICE_NAME=...` or
`DEVICE_MAC=...` env vars; run the harness directly with
`node tools/dfu-test.mjs <path-to-zephyr.signed.bin>`.

To prove the assertion has teeth, point it at the **baseline** `.bin` (same
version as what's running) — it must exit non-zero, since no swap is observable.

---

## Manual full-stack check (Chrome)

The steps below exercise the browser path the harness skips.

### Step 1 — Flash the initial firmware

Build the `smp_svr` sample — this is a Zephyr sample specifically for testing SMP/mcumgr over BLE. The `--sysbuild` flag makes NCS build MCUboot alongside the app automatically.

```bash
west build -b nrf52840dk/nrf52840 \
  zephyr/samples/subsys/mgmt/mcumgr/smp_svr \
  --sysbuild

west flash
```

The device will advertise as **"Zephyr"** over BLE.

---

### Step 2 — Build the update image

Bump the version number so you can confirm the swap worked after DFU.

```bash
west build -b nrf52840dk/nrf52840 \
  zephyr/samples/subsys/mgmt/mcumgr/smp_svr \
  --sysbuild \
  -- -DCONFIG_MCUBOOT_IMGTOOL_SIGN_VERSION=\"2.0.0\"
```

The file to upload is:

```
build/zephyr/zephyr.signed.bin
```

---

### Step 3 — Serve the web app over HTTPS

Web Bluetooth requires a secure context (HTTPS or localhost). The project includes
a small Python HTTPS server that auto-generates a self-signed certificate:

```bash
cd path/to/web-smp-dfu
./serve.py
```

On first run it creates `.localhost.pem` / `.localhost-key.pem`. Open
`https://localhost:8443` in Chrome, accept the certificate warning once, and
Web Bluetooth will work without any flags.

If you need to access the page from another machine on your LAN:

```bash
./serve.py 0.0.0.0
```

Then open `https://<host-ip>:8443` on the target device.

**Fallback:** If you prefer plain HTTP, use `python3 -m http.server 8080` and
enable `chrome://flags/#unsafely-treat-insecure-origin-as-secure` for
`http://localhost:8080`.

Web Bluetooth requires HTTPS. For local HTTP, enable this Chrome flag:

1. Open `chrome://flags/#unsafely-treat-insecure-origin-as-secure`
2. Add `http://localhost:8080`
3. Relaunch Chrome

---

### Step 4 — Run the DFU

1. Open `http://localhost:8080` in Chrome
2. Click **Choose file** → select `build/zephyr/zephyr.signed.bin`
3. Click **Scan & Connect** → pick "Zephyr" from the browser device picker
4. App auto-detects SMP protocol and reads image slots — slot 0 should show `1.0.0`
5. Click **Update Firmware**
6. Watch the progress bar and log panel
7. Device resets automatically when upload + marking is done

---

### Step 5 — Verify

After the device reboots (~5 seconds):

1. Click **Scan & Connect** again
2. Click **Refresh slots**
3. Slot 0 should now show `2.0.0` and be marked **active + confirmed**

---

## Nordic Secure DFU verification

### Structural (no hardware)

Feed each `.zip` package to `nordic/package.js` and assert the manifest parses:

```bash
node -e "
import JSZip from './vendor/jszip.mjs';
import { SecureDfuPackage } from './nordic/package.js';
const buf = await Bun.file('path/to/package.zip').arrayBuffer();
const pkg = new SecureDfuPackage(buf);
await pkg.load(JSZip);
console.log('manifest', pkg.manifest);
const img = await pkg.getAppImage();
console.log('app image', img.type, img.initFile, img.imageFile);
"
```

### Hardware (nRF52840 DK)

Flash the DK with a Nordic Secure DFU bootloader baseline from SDK 17.1.0:
`sd_s140_bootloader_buttonless_with_setting_page_dfu_secure_ble_debug_without_bonds.hex`.

Pick the matching `.zip` (e.g. `ble_app_buttonless_dfu_without_bonds_s140.zip`),
connect in Chrome, and confirm the transfer completes. The buttonless flow will
prompt for reconnect after the device reboots into bootloader mode.

---

## Debugging

### Chrome DevTools console

Open F12 → Console before connecting. All SMP traffic is logged:

```
[SMP] → tx seq=0 op=2 group=1 cmd=0 total=172B chunks=2   ← sent upload chunk
[SMP] ← rx seq=0 op=3 group=1 cmd=0 { off: 128, rc: 0 }  ← device ack
[DFU] chunk offset=0 → device ack'd off=128 rc=0
```

If you see timeouts or no `← rx` entries, the device is not responding to SMP.

### Sanity check — confirm device side works before blaming the web app

**Option A — nRF Connect app (Android/iOS):**
Install Nordic's nRF Connect app → connect to the device → Device → DFU tab. If this can DFU the device, the device firmware is correct and the issue is in the web app.

**Option B — mcumgr CLI:**

```bash
# Install
go install github.com/apache/mynewt-mcumgr-cli/mcumgr@latest

# List images over BLE
mcumgr --conntype ble --connstring ctlr_name=hci0,peer_name=Zephyr conn image list
```

### Packet-level debugging — nRF Sniffer + Wireshark

When you need to see raw BLE packets (wrong chunk size, MTU issues, silent drops):

1. Get an **nRF52840 USB dongle** (PCA10059) — ~$10
2. Flash the nRF Sniffer firmware from Nordic: https://www.nordicsemi.com/Products/Development-tools/nRF-Sniffer-for-Bluetooth-LE
3. Install the Wireshark plugin (included in the sniffer download)
4. Open Wireshark → select the sniffer interface → filter: `btle`

The sniffer decodes SMP frames inside GATT notifications — you can see exactly what the device received and responded with.

---

## Common failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| Device picker is empty / no devices found | Device not advertising, or built without SMP BLE enabled | Check Kconfig, power-cycle device |
| Connects but `listImages` times out | SMP not responding — notifications not enabled or wrong characteristic | Check device logs over RTT/UART |
| Upload starts but stalls at 0% | Chunk too large for negotiated MTU | Reduce chunk size to 64 or 32 |
| Upload completes but device doesn't reboot | `testImage` or `resetDevice` failed | Check DevTools console for rc codes |
| After reboot, slot 0 still shows `1.0.0` | MCUboot swap failed — image hash mismatch or image not valid | Make sure you're uploading `zephyr.signed.bin` not `zephyr.bin` |
| `Bad MCUboot magic` error in UI | Wrong file selected | Use `build/zephyr/zephyr.signed.bin`, not the `.hex` or unsigned `.bin` |
| Legacy DFU hard-stop message | Device advertises `0x1530` service | Upgrade to Secure DFU bootloader |
