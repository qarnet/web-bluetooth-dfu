# Feature Backlog

Active development is tracked in `AGENTS.md` and `TESTING.md`. This file lists
future work that is **not yet scheduled** but has been identified as valuable.

---

## UI / UX

- [x] **Drag-and-drop file input** — shipped. Drop a `.bin` or `.zip` anywhere onto the Firmware section. Visual border highlight (`drag-active` class) on `dragenter`/`dragover`, removed on `dragleave`/`drop`. Same validation and controller path as the file picker.

---

## Error Handling

### Better error recovery in the UI (priority: very high)

The current UI shows errors in the log panel but does not help the user recover.
Common recoverable failures need explicit action buttons:

| Failure scenario | Current behavior | Desired behavior |
|---|---|---|
| Upload stalls at 0% (MTU too large) | Log error, user must reconnect | Auto-retry with halved chunk size; or a "Retry with 64-byte chunks" button |
| `listImages` timeout after connect | Disconnect, manual retry | "Retry read" button; or auto-retry once |
| Device disconnects mid-transfer | Error log only | "Resume / Reconnect" button that preserves state |
| `testImage` or `resetDevice` fails | No visible error detail | Show the rc code and suggest fix |
| Wrong file type selected | "Bad MCUboot magic" error | More specific error with file extension hint |
| Nordic buttonless trigger fails | Silent failure or cryptic error | "Device not in buttonless mode" with flash instructions |

**Scope:**
- Add a `recoverableError` flag to provider errors or a dedicated event
- `app.js`: on `recoverableError`, render a contextual action button in the log
- SMP provider: retry logic for chunk size halving on MTU stall

**Estimated effort:** 2–3 commits, touches `app.js`, both providers, and `index.html`.

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

- **PWA support:** Add `manifest.json` and service worker for offline capability.
- **Theme toggle:** The dark mode is hardcoded; a light mode toggle is trivial CSS work.
- **Keyboard shortcuts:** `Ctrl+U` to trigger DFU, `Ctrl+R` to reconnect.
- **Firmware version display:** Show the expected version parsed from the `.bin`/`.zip`
  in the UI before starting DFU.
- **DFU history:** Persist last successful firmware file path in `localStorage`
  (security note: only the path, never the binary itself).
- **Chunk size auto-negotiation:** Instead of a manual input, try default 244 bytes
  and automatically fall back if the first chunk stalls.
- **Progress bar smoothing:** The bar currently jumps on chunk ack; use CSS transition
  or a small running-average to smooth visual updates.
- **Log export:** Add a "Copy logs" or "Download logs" button for bug reports.

---

## How to add a feature

1. Confirm with user that the priority and scope are still correct.
2. Add a checkbox to the feature description above (`- [ ]`) and note the branch name.
3. Implement, test against hardware or the headless harness.
4. Update `AGENTS.md` if architectural constraints change.
5. Remove the feature from this file once shipped.
