# Project Status — web-smp-dfu

## What's done

### 1. Firmware adapted from NCS sample
- **Source**: `nrf/samples/dfu/smp_svr` from nRF Connect SDK v3.3.0 (`~/ncs/v3.3.0`)
- **Location**: `firmware/` (`CMakeLists.txt`, `prj.conf`, `Kconfig.sysbuild`,
  `sysbuild.conf`, `sysbuild/mcuboot/prj.conf`, `src/main.c`, `src/bluetooth.c`,
  `src/common.h`)
- **Config highlights**: BLE SMP transport, large MTU (498), packet reassembly,
  MCUboot swap mode, image-management + OS-reset groups, shell transport fallback.

### 2. Built for nRF52840 DK (`PCA10056`)
- v1 baseline → `firmware/build/` (image version `0.0.0+0`)
- v2 update → `firmware/build-v2/` (image version `2.0.0`)
- MCUboot magic verified on both `zephyr.signed.bin` files.

### 3. Flashed the device
- `nrfutil device program --firmware firmware/build/merged.hex --traits jlink`
- Device runs the SMP server, advertises as **"Zephyr"** over BLE.

### 4. Automated A→B→C→D workflow
A headless test harness now runs the full DFU over real BLE — no browser, no
manual steps. It reuses the app's actual `smp/protocol.js` + `smp/image.js`
modules over a node-ble transport, so the test exercises the shipped protocol
code. See `tools/dfu-test.mjs` and the `Makefile`.

| Step | Command | What it does |
|---|---|---|
| **A** Write code | — | edit `firmware/src/*` or `smp/*.js` |
| **B** Compile | `make build` | west builds v1 + v2 images |
| **C** Flash | `make flash` | flash the v1 baseline |
| **D** Test | `make test` | re-flash baseline, run the BLE DFU harness |
| Full loop | `make dfu` | B + D |

The harness asserts: device boots the baseline → upload v2 → mark for test →
reset → MCUboot swaps → slot 0 reports v2 `active` → confirm → slot 0
`confirmed`. Exit code 0 = pass.

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
- Known gap surfaced while building the harness: `app.js`'s DFU flow stops
  after `resetDevice` and never calls `confirmImage`, so a real browser DFU
  would revert on the next reboot. The harness does confirm. Fixing `app.js`
  to confirm post-reboot is a candidate follow-up.
