# Nordic Secure DFU Verification Plan

## Context

The unified dual-protocol SMP+Nordic architecture is implemented.

- **SMP / MCUboot** — verified on nRF52840 DK via `make test` (pass).
- **Nordic Secure DFU** — ported but never verified on hardware. This plan is the next work package.

## Goal

Verify the Nordic Secure DFU provider end-to-end on the nRF52840 DK and produce a passing headless harness.

## Test Fixtures (SDK 17.1.0)

Location: `.../nRF5_SDK_17.1.0_ddde560/examples/dfu/secure_dfu_test_images/ble/nrf52840/`

| Fixture | Role |
|---|---|
| `sd_s140_bootloader_buttonless_with_setting_page_dfu_secure_ble_debug_without_bonds.hex` | Baseline firmware to flash onto DK |
| `ble_app_buttonless_dfu_without_bonds_s140.zip` | Update package (.zip with init + app .bin/.dat) |
| `hrs_application_s140.zip` | Alternative single-app .zip |

## Code Changes Required

### 1. Patch `nordic/secure-dfu.js`

`connect(device)` currently does its own `getCharacteristics()` — node-ble chars are EventEmitters, not DOM EventTargets. The headless harness wraps them in `BleCharacteristic`. Allow `connect(device, characteristics)` to accept pre-resolved chars:

```js
async connect(device, characteristics = null) {
  // ...existing disconnect listener...
  const ch = characteristics ?? await this._gattConnect(device);
  // ...rest unchanged...
}
```

Also update `_gattConnect` to return wrapped chars when available.

### 2. Patch `nordic/nordic-provider.js`

In `attach()`, after buttonless check, if control+packet are present, pass them to `connect()`:

```js
const allChars = [...chars.values()]; // already BleCharacteristic-wrapped
await this._dfu.connect(device, allChars);
```

### 3. New headless harness: `tools/nordic-dfu-test.mjs`

Responsibilities:
1. Connect via node-ble to device named `DfuTarg`.
2. Discover FE59 service, wrap Control Point + Packet chars in `BleCharacteristic`.
3. Build `session` object: `{ device, server, services }` where `services` is the `Map<string, {service, characteristics: Map<uuid, BleCharacteristic>}>` that `NordicProvider.attach()` expects.
4. Call `provider.attach(session)`.
   - If buttonless-only: catch disconnect, re-scan after ~8s, re-connect to `DfuTarg`, re-attach.
5. Load `.zip` via `provider.loadFirmware(buf)`.
6. Run `provider.runUpdate()`.
7. Assert success (no thrown Error).

Exit codes:
- `0` = transfer complete
- `1` = failure
- `2` = bad usage

### 4. Structural `.zip` parse test (no BLE)

Before hardware, sanity-check each manifest variant:
- `hrs_application_s140.zip`
- `ble_app_buttonless_dfu_without_bonds_s140.zip`
- `bootloader_secure_ble_debug_without_bonds_s140.zip`

Ensure `SecureDfuPackage.load()` + `getAppImage()` / `getBaseImage()` return valid `{initData, imageData}` buffers.

## Execution Steps

1. **Patch code** — apply the three code changes above.
2. **Structural test** — run `.zip` parse sanity against all fixtures.
3. **Flash Nordic baseline** — flash `sd_s140_bootloader_buttonless_with_setting_page_dfu_secure_ble_debug_without_bonds.hex` onto the DK.
4. **Run headless harness** — `node tools/nordic-dfu-test.mjs <path-to-zip>`
5. **Observe** — transfer should complete with exit 0.
6. **Reflash SMP** — return DK to Zephyr SMP baseline (`make flash`) so `make test` continues to work.

## Rollback / Recovery

- If Nordic test bricks or the DK stops advertising: recover by re-flashing the SMP baseline hex with J-Link (`nrfutil device program --traits jlink --firmware firmware/build/merged.hex`).
- `nrfjprog --recover` is the nuclear option if the device is locked.

## Success Criteria

- `tools/nordic-dfu-test.mjs` exits 0 after completing a full `.zip` transfer over BLE.
- No manual Chrome UI verification is required for this session (the headless harness is the gate).
- The SMP baseline (`make test`) can be re-run after the DK is re-flashed back to SMP.
