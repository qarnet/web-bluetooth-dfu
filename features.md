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

### Multi-image Nordic support (priority: low)

Currently the Nordic path handles **single-application** `.zip` packages.
Nordic packages can also contain:
- `softdevice_bootloader` — SoftDevice + Bootloader combined
- `softdevice` + `bootloader` — separate images
- Multi-core (application + network core on nRF5340)

`nordic/package.js` already parses the manifest and returns `getAppImage()` / `getBaseImage()`.
Extending this to handle `softdevice_bootloader` type is mostly plumbing in
`NordicProvider.runUpdate()` to call the right sequence of `transferInit` + `transferFirmware`
for each sub-image.

**Scope:**
- Extend `SecureDfuPackage` to discover all image types in manifest
- Extend `NordicProvider.loadFirmware()` to return an ordered list of images
- Extend `runUpdate()` to iterate: init packet → firmware for each image
- This is already architected but not tested — low priority because single-image
  is the current target hardware (nRF52840 DK).

**Estimated effort:** 1–2 commits, touches `nordic/package.js` and `nordic/nordic-provider.js`.

---

## Misc Observations (not scheduled)

- [x] **PWA support** — shipped. Added `manifest.json`, `icon.svg`, and `sw.js` service worker. App works offline after first load and can be installed as standalone.
- [x] **Progress bar smoothing** — shipped. Added `transition: width 0.3s ease` to `.progress-fill` for smooth visual updates instead of chunk-jumps.
- **Firmware version display:** Show the expected version parsed from the `.bin`/`.zip` in the UI before starting DFU.
- **DFU history:** Persist last successful firmware file path in `localStorage` (security note: only the path, never the binary itself).

---

## How to add a feature

1. Confirm with user that the priority and scope are still correct.
2. Add a checkbox to the feature description above (`- [ ]`) and note the branch name.
3. Implement, test against hardware or the headless harness.
4. Update `AGENTS.md` if architectural constraints change.
5. Remove the feature from this file once shipped.
