# Project Status — web-smp-dfu

## What's done

### Dual-protocol DFU engine
The app now supports **both** SMP/MCUboot (Zephyr/NCS) and Nordic Secure DFU
(nRF5 SDK legacy) via a single provider-agnostic UI. The protocol is
auto-detected from the file magic and the BLE GATT services discovered on the
device.

### 1. SMP / MCUboot path (Zephyr/NCS)
- **Firmware**: `firmware/` — adapted from `nrf/samples/dfu/smp_svr` (NCS v3.3.0)
- **Built**: v1 baseline in `firmware/build/`, v2 update in `firmware/build-v2/`
- **Verified**: `make test` passes — full upload → test → reset → swap → confirm
- **Modules**: `smp/protocol.js`, `smp/image.js`, `core/provider.js`

### 2. Nordic Secure DFU path (legacy nRF5 SDK)
- **Reference hex**: `sd_s140_bootloader_buttonless_with_setting_page_dfu_secure_ble_debug_without_bonds.hex`
- **Test package**: `ble_app_buttonless_dfu_without_bonds_s140.zip`
- **Verified**: `node tools/nordic-dfu-test.mjs <package.zip>` passes — full
  buttonless trigger → bootloader reconnect → init packet → firmware transfer
- **Modules**: `nordic/secure-dfu.js`, `nordic/package.js`, `nordic/nordic-provider.js`

### 3. Shared infrastructure
- `core/detect.js` — auto-detects protocol from file + device services
- `core/provider.js` — `DfuProvider` base class with capability flags
- `core/registry.js` — central UUID registry for both protocols
- `vendor/crc32.js` — correct CRC-32 implementation matching Nordic firmware
- `vendor/jszip.js` — vendored ZIP parser for Nordic packages
- `app.js` / `index.html` — single UI that adapts its flow to the detected protocol

---

## One-time environment setup

The harness needs a working BLE stack. The WSL2 kernel supports Bluetooth
(`CONFIG_BT=m`, `btusb` present) and the ASUS USB-BT500 dongle is passed
through; only userspace setup is missing. Run these once (`!` prefix in the
Claude Code prompt runs them in-session):

```
sudo apt-get update && sudo apt-get install -y bluez build-essential
sudo mkdir -p /lib/firmware/rtl_bt
sudo curl -L -o /lib/firmware/rtl_bt/rtl8761bu_fw.bin \
  https://git.kernel.org/pub/scm/linux/kernel/git/firmware/linux-firmware.git/plain/rtl_bt/rtl8761bu_fw.bin
sudo curl -L -o /lib/firmware/rtl_bt/rtl8761bu_config.bin \
  https://git.kernel.org/pub/scm/linux/kernel/git/firmware/linux-firmware.git/plain/rtl_bt/rtl8761bu_config.bin
sudo modprobe btusb
sudo systemctl enable --now bluetooth
sudo usermod -aG bluetooth $USER      # then restart the WSL shell
bluetoothctl show                     # must list a controller, Powered: yes
```

Then install the harness deps: `make harness-deps` (pure JS, no compiler step).

If `bluetoothctl show` lists no controller: re-attach the dongle via `usbipd`
from Windows, then `sudo modprobe -r btusb && sudo modprobe btusb`.

---

## Scope notes

- The harness covers `smp/protocol.js` + `smp/image.js` (framing, CBOR,
  chunking, the full DFU sequence). It does **not** exercise
  `bluetooth/connect.js` (`navigator.bluetooth`) or the DOM — verify those
  manually in Chrome per `TESTING.md`.
- Browser flow now handles confirmation: after reconnecting post-reset, if
  slot 0 shows `active + pending`, a "Confirm Update" button is surfaced.
  Clicking it sends `image confirm`, making the swap permanent and preventing
  MCUboot rollback.
