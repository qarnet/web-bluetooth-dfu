## Nordic Multi-Image Browser Bug Status (2026-05-26)

### Reference checkpoint

- Commit: `5d1c0dc`
- Purpose: stable comparison point before deeper continuation-path debugging.

### What is currently passing

- SMP headless DFU harness: `make test` -> PASS
- Nordic single-image headless harness: `node tools/nordic-dfu-test.mjs test/fixtures/nordic/ble_app_buttonless_dfu_without_bonds_s140.zip` -> PASS
- Nordic multi-image headless harness (node-ble): `node tools/nordic-dfu-test.mjs --multi-image tests/fixtures/multi_image_s140.zip` -> PASS
- SMP browser E2E (Puppeteer + Web Bluetooth): PASS after picker hardening.

### What is failing

- Nordic multi-image browser E2E:
  - Command: `make browser-test-nordic-multi-headless ZIP=tests/fixtures/multi_image_s140.zip`
  - Status: FAIL (deterministic reproduction).

### Failure signature

1. App-mode connect succeeds.
2. Buttonless transition to bootloader succeeds.
3. Base image transfer succeeds.
4. Continuation reconnect succeeds.
5. Application transfer starts, enters crash-retry path.
6. Retry phase init transfer reaches checksum and attempts `EXECUTE`.
7. Device disconnects immediately during/after init `EXECUTE`.
8. Browser flow times out waiting for app image completion.

Observed console pattern in failing runs:

- `CRC OK, sending EXECUTE ... (transferred=144, type=1)`
- followed by disconnect events and `EXECUTE failed ... Device disconnected`

### Why this is important

- Node-ble multi-image harness passes with the same package and expected flow.
- Browser path fails at continuation retry boundary.
- This strongly suggests a Web Bluetooth reconnect/session/continuation-state interaction, not a generic DFU algorithm failure.

### Recent debugging changes

- Removed non-deterministic picker fallback; tests now fail deterministically with explicit observed-device logging.
- Adjusted continuation crash handling in `app-controller.js` to avoid auto-reconnect races and force explicit reconnect state.
- These changes improved determinism but did not resolve the continuation retry failure.

### Next focused steps

1. Instrument opcode/response timeline around continuation retry init `EXECUTE`.
2. Log exact reconnect identity and characteristic map before retry.
3. Verify retry init packet bytes/hash match node-ble passing path.
4. Cross-reference nRF5 SDK Secure DFU continuation/init execute behavior in offline docs/source.
5. Apply minimal targeted fix and rerun:
   - `make test`
   - Nordic single-image harness
   - Nordic multi-image browser E2E
