# Feature Backlog

Active development is tracked in `AGENTS.md` and `TESTING.md`. This file lists
future work that is **not yet scheduled** but has been identified as valuable.

---

## UI / UX

- [x] **Drag-and-drop file input** — shipped. Drop a `.bin` or `.zip` anywhere onto the Firmware section. Visual border highlight (`drag-active` class) on `dragenter`/`dragover`, removed on `dragleave`/`drop`. Same validation and controller path as the file picker.

---

## Error Handling

- [x] **Better error recovery in the UI** — shipped. Recoverable errors now show contextual action buttons inline in the log panel (Retry, Reconnect). Connection failures and device disconnects are recoverable. MTU auto-halving logs include recovery hints.

---

---

## Nordic Secure DFU

- [x] **Multi-image Nordic support** — shipped. `SecureDfuPackage` already discovers all manifest types (`softdevice`, `bootloader`, `softdevice_bootloader`, `application`). `NordicProvider` supports both single-image and multi-image (base + application) flows with the `--multi-image` flag and continuation reboot. Verified on nRF52840 DK with SDK 17.1.0 test fixtures.

---

## Misc Observations (not scheduled)

- [x] **PWA support** — shipped. Added `manifest.json`, `icon.svg`, and `sw.js` service worker. App works offline after first load and can be installed as standalone.
- [x] **Progress bar smoothing** — shipped. Added `transition: width 0.3s ease` to `.progress-fill` for smooth visual updates instead of chunk-jumps.
- [x] **Firmware version display** — shipped. Parses version from `.bin` MCUboot header and from device active slot state. Shows both in UI.
- [x] **DFU history** — shipped. On successful update, persists `{name, protocol, version, ts}` to `localStorage` under `dfu-last-firmware`. Security note: only metadata, never the binary.

---

## How to add a feature

1. Confirm with user that the priority and scope are still correct.
2. Add a checkbox to the feature description above (`- [ ]`) and note the branch name.
3. Implement, test against hardware or the headless harness.
4. Update `AGENTS.md` if architectural constraints change.
5. Remove the feature from this file once shipped.
