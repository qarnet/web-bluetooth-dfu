# Test Fixtures

These files are included in the repo so anyone with an nRF52840 DK can verify all three DFU modes without needing the nRF5 SDK or NCS toolchain installed.

## SMP / MCUboot (Zephyr / NCS)

| File | Size | Purpose |
|---|---|---|
| `smp/merged.hex` | 680 KB | Baseline firmware (v1.0.0) + MCUboot, to flash onto the DK |
| `smp/zephyr.signed.bin` | 208 KB | DFU update image (v2.0.0) — upload this via the web app or `make test` |

### Quick verify

```bash
make test   # flashes merged.hex, then DFU zephyr.signed.bin over BLE
```

Or flash manually and test in Chrome:

```bash
nrfutil device program --firmware test/fixtures/smp/merged.hex --traits jlink
nrfutil device reset --traits jlink
```

Then open https://localhost:8443, select `zephyr.signed.bin`, connect to "Zephyr", and click **Update Firmware**.

---

## Nordic Secure DFU (nRF5 SDK 17.1.0)

All files are from the official Nordic SDK `examples/dfu/secure_dfu_test_images/ble/nrf52840/` and are covered by the Nordic 5-clause BSD license (see `license.txt`).

### Baseline images (flash these first)

These combine the SoftDevice + bootloader + settings page. Flash the `.hex` that matches your bonding preference.

| File | Size | Bonds | Notes |
|---|---|---|---|
| `nordic/sd_s140_bootloader_buttonless_with_setting_page_dfu_secure_ble_debug_with_bonds.hex` | 716 KB | yes | Bonding preserved across DFU |
| `nordic/sd_s140_bootloader_buttonless_with_setting_page_dfu_secure_ble_debug_without_bonds.hex` | 716 KB | no | Simpler, recommended for first test |

### DFU packages (upload via web app)

| File | Size | Type | Upload to |
|---|---|---|---|
| `nordic/ble_app_buttonless_dfu_without_bonds_s140.zip` | 56 KB | Application | Buttonless bootloader |
| `nordic/ble_app_buttonless_dfu_with_bonds_s140.zip` | 56 KB | Application | Buttonless bootloader (bonding) |
| `nordic/softdevice_s140.zip` | 152 KB | Base image (SoftDevice) | Buttonless bootloader |
| `nordic/hrs_application_s140.zip` | 100 KB | Application | Continuation bootloader |

### Multi-image fixture

For testing the two-step base → reboot → app flow, combine `softdevice_s140.zip` + `hrs_application_s140.zip` into a single multi-image package (tools like `nrfutil` or a `node` script can merge manifests). The CI uses a pre-merged `/tmp/multi_image_dfu_test.zip` for the multi-image harness.

### Quick verify (single image)

```bash
# Flash the bootloader baseline
nrfutil device program \
  --firmware test/fixtures/nordic/sd_s140_bootloader_buttonless_with_setting_page_dfu_secure_ble_debug_without_bonds.hex \
  --traits jlink

# Run single-image DFU
node tools/nordic-dfu-test.mjs test/fixtures/nordic/ble_app_buttonless_dfu_without_bonds_s140.zip
```

### Quick verify (multi-image)

```bash
# Flash the bootloader baseline (same as above)

# Run multi-image DFU (base image + application)
node tools/nordic-dfu-test.mjs --multi-image /tmp/multi_image_dfu_test.zip
```

Or in Chrome: select the `.zip`, click **Scan & Connect**, pick "Nordic_Buttonless" (or "DfuTarg" / "DfuTest" after reboot). The web app auto-detects Nordic Secure DFU.

---

## Hardware required

- **nRF52840 DK** (`PCA10056`) — target device
- **BLE adapter** visible to BlueZ (`hci0`) — for Linux headless tests

See [`AGENTS.md`](../AGENTS.md) and [`TESTING.md`](../TESTING.md) for environment setup and troubleshooting.
