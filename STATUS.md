# Project Status — web-smp-dfu

## What's already done

### 1. Firmware adapted from NCS sample
- **Source**: `nrf/samples/dfu/smp_svr` from nRF Connect SDK v3.3.0 (`~/ncs/v3.3.0`)
- **Location in repo**: `firmware/`
- **Files created**:
  - `firmware/CMakeLists.txt`
  - `firmware/prj.conf`
  - `firmware/Kconfig.sysbuild`
  - `firmware/sysbuild.conf`
  - `firmware/sysbuild/mcuboot/prj.conf`
  - `firmware/src/main.c`
  - `firmware/src/bluetooth.c`
  - `firmware/src/common.h`
- **Config highlights**: Bluetooth LE SMP transport enabled, large MTU (251), packet reassembly (5×498 bytes), MCUboot swap mode, image management + OS reset groups, shell transport as fallback.

### 2. Built for nRF52840 DK (`PCA10056`)
- **Build command used**:
  ```bash
  nrfutil sdk-manager toolchain launch --ncs-version v3.3.0 --chdir ~/ncs/v3.3.0 -- \
    west build -b nrf52840dk/nrf52840 --sysbuild --build-dir <...>/firmware/build <repo>/firmware
  ```
- **First image**: default version = `1.0.0`
  - Output: `firmware/build/firmware/zephyr/zephyr.signed.bin`
- **Second image**: bumped to version `2.0.0`
  - Output: `firmware/build-v2/firmware/zephyr/zephyr.signed.bin`
- **MCUboot magic verified** (`0x96f3b83d`) on both `.signed.bin` files.

### 3. Flashed the device
- **Command**: `nrfutil device program --firmware <repo>/firmware/build/merged.hex --traits jlink`
- **Result**: Device is running the initial SMP server firmware with BLE advertising.

---

## What's next (decisions needed)

You said the main focus is testing the **Web Bluetooth API** part of the project. The current server environment is headless Linux — no Chrome, no BlueZ BLE stack, and no graphical display.

### Option A — Run the web app locally on this machine (for remote access)
1. Serve the app with `python3 -m http.server 8080` from the repo root.
2. You open it in Chrome on your own computer (Chrome desktop or Android).
3. **Requirement**: You need to either:
   - Enable the Chrome flag `unsafely-treat-insecure-origin-as-secure` for `http://<server-ip>:8080`, **or**
   - Serve over HTTPS (e.g., `caddy file-server --root . --listen :8080`).
4. In the app: choose the v2 `zephyr.signed.bin`, scan & connect to "Zephyr", flash, wait for reboot, then reconnect to verify slot 0 shows `2.0.0`.

### Option B — Python + bleak sanity checker (before trusting the web app)
1. Install a venv and `bleak` to scan for the advertising "Zephyr" device.
2. Optionally write a minimal Python SMP client to do `image list` / `upload` / `test` / `reset` over BLE.
3. This proves the firmware side works end-to-end, isolating any web-app bugs.

### Option C — Both A and B
Do the Python sanity check first to confirm the device advertises and responds to SMP, then proceed to the web app test in Chrome.

---

## Quick reference — files to flash / upload

| Purpose | Path |
|---|---|
| Initial flash (MCUboot + app v1.0.0) | `firmware/build/merged.hex` |
| Update image for web DFU (app v2.0.0) | `firmware/build-v2/firmware/zephyr/zephyr.signed.bin` |

---

## Outstanding questions / decisions

1. **Do you want me to start the HTTP server now?**
2. **Can your client machine reach this server over the network?**
3. **Do you want the Python bleak scan/SMP sanity script written before the web test?**
4. **Chunk size**: web app default is 128 B. You can tune up to 244 B in the UI if the MTU negotiation succeeds (expected ~247 B on nRF).
5. **Should the device name be something other than "Zephyr"?** (`CONFIG_BT_DEVICE_NAME` in `prj.conf`).

---

*Written automatically. Feel free to edit and return when ready to continue.*
