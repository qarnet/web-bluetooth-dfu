# Missing Features Analysis: web-smp-dfu vs nRF5 SDK 17.1.0

## Methodology

Researched by reading nRF5 SDK 17.1.0 bootloader/dfu source code, comparing against our implementations in `nordic/` and `smp/` directories.

---

## Nordic Secure DFU (nRF5 SDK `components/libraries/bootloader/dfu/`)

### ✅ What We Support Well

| Feature | Status | Notes |
|---|---|---|
| Object transfer (init + firmware) | ✅ | `transferObject()` handles CREATE → WRITE → CRC → EXECUTE cycle |
| Resume after reconnect (same object) | ✅ | `transfer()` reads offset from SELECT response and resumes from `effectiveOffset` |
| CRC validation | ✅ | `checkCrc()` validates after each object using vendored `crc32.js` |
| Extended error codes | ✅ | Full lookup table (0x00-0x0C) in `EXTENDED_ERROR` object |
| Buttonless DFU (with/without bonds) | ✅ | Detects both `8ec90003` and `8ec90004` UUIDs, triggers correct variant |
| Multi-image (base + application) | ✅ | `--multi-image` mode with continuation reboot |

### ⚠️ Partial / Missing Features

| Feature | Status | SDK Behavior | Our Behavior | Impact |
|---|---|---|---|---|
| **Receipt Notifications (PRN)** | ⚠️ Partial | SDK sets PRN to batch acknowledgments (e.g., every 10 packets) | `RECEIPT_NOTIFICATIONS` opcode defined but never sent | Higher overhead on every packet write. Slower on high-latency links. |
| **Write-with-response fallback** | ❌ Missing | SDK uses write-with-response for reliability when needed | Only uses `writeValueWithoutResponse` with fixed delay | If a write fails silently, we don't know until CRC check fails. Less reliable on noisy links. |
| **Connection parameter updates** | ❌ Missing | SDK requests specific connection intervals after connect | Not handled (Chrome manages internally) | Cannot optimize for throughput vs latency. |
| **MTU exchange** | ❌ Missing | SDK negotiates MTU up to 247 bytes | Fixed floor of 20 bytes (`PACKET_SIZE = 20`) | Very slow transfers. We should negotiate higher if possible. |
| **Resume across full DFU session** | ⚠️ Partial | SDK stores progress in `s_dfu_settings.progress` (offset, CRC) persistently | We resume the *current object* but not across full init→firmware sequence | If disconnect happens after init packet execute but before firmware create, we start firmware from 0 (which is correct). But if firmware object is large and disconnects mid-transfer, the SDK resumes at the last object boundary; we also do this via SELECT offset. |

---

## SMP / MCUboot (Zephyr `smp_svr` sample)

### ✅ What We Support Well

| Feature | Status | Notes |
|---|---|---|
| Image upload with SHA-256 | ✅ | First chunk includes `len` + `sha`, device validates |
| Image test | ✅ | Marks slot 1 as pending |
| Image confirm | ✅ | Locks in swap permanently |
| Reset | ✅ | Expects timeout (device disconnects immediately) |
| Image slot listing | ✅ | Reads all slots with active/pending/confirmed state |
| MTU auto-halving | ✅ | On timeout, halves MTU (244→122→61→20) |
| Multiple timeout retries | ✅ | Up to 6 total timeouts, 2 consecutive before halving |

### ⚠️ Partial / Missing Features

| Feature | Status | SDK Behavior | Our Behavior | Impact |
|---|---|---|---|---|
| **Image slot erase** | ⚠️ Implemented but not exposed | `cmdImageErase()` exists in `mcumgr.js` | Never called by `SmpProvider` or UI | If slot 1 has stale data, upload fails with "Bad state". User must reconnect or manually erase. |
| **Resume after disconnect** | ❌ Missing | Upload offset tracked per session. Reconnect + re-upload continues from last ack'd offset | Upload offset resets to 0 on new `cmdUpload()` call | If 200 KB uploaded and device disconnects, the next upload starts from 0. Wastes time and battery. |
| **OS info query** | ❌ Missing | `OS_MGMT_ID_INFO` returns device name, kernel version, uptime | Only implements reset (OS_MGMT_ID_RESET = 5) | Cannot show device info before DFU. |
| **Upload cancellation** | ✅ Implemented | `cancelUpload()` stops in-flight upload | Available but not wired to UI | User cannot cancel an active upload from the UI. |
| **Multiple image upload** | ❌ Missing | nRF5340 requires separate app + net core images | Single image only (slot defaults to 0) | Not relevant for nRF52840 DK target, but needed for nRF5340. |

---

## General Web Bluetooth Limitations (Not Our Bug, But Affects UX)

| Limitation | Impact | Workaround |
|---|---|---|
| Cannot query negotiated MTU | We default to 20 bytes (Nordic) or 128 (SMP) | No workaround possible in JS. Chrome internally negotiates. |
| Cannot manage bonds | Paired devices may reconnect automatically, unpaired won't | User must pair via OS settings first for bonded mode. |
| Cannot set connection parameters | Throughput is whatever Chrome chooses | None. |
| Device picker requires user gesture | Cannot auto-scan | By design for security. |
| `writeValueWithoutResponse` may fail silently | No ACK per packet | Rely on CRC and timeout logic. |

---

## Priority Ranking of Missing Features

### 🔴 High Impact / Should Implement

1. **SMP upload resume after disconnect** — `cmdUpload` should accept a starting offset, and `SmpProvider` should persist the last ack'd offset. On reconnect, resume instead of restarting. This is the biggest time-waster for large firmware files.

2. **Image slot erase button** — When `listImages` shows slot 1 in "bad state", show an "Erase slot" button that calls `cmdImageErase()`. Prevents the "upload failed: bad state" error.

3. **Receipt Notifications (PRN) for Nordic** — Setting PRN to e.g., 10 would reduce notification overhead and speed up transfers significantly. One-liner: add `setReceiptNotifications(n)` after control notifications are enabled.

### 🟡 Medium Impact / Nice to Have

4. **Write-with-response fallback** — If `writeValueWithoutResponse` throws or times out, retry with `writeValueWithResponse`. More reliable on poor links.

5. **OS info query** — Read device name and kernel version via `OS_MGMT_ID_INFO` and display in UI.

6. **Upload cancellation button** — Wire `MCUManager.cancelUpload()` to a "Cancel" button during active upload.

### 🟢 Low Impact / Future Work

7. **nRF5340 multi-image SMP** — Separate app + net core upload. Not needed for current nRF52840 target.

8. **Connection parameter optimization** — Cannot be done from JS anyway.

---

## Recommendations

1. **Implement SMP resume** — Add `offset` parameter to `cmdUpload`, track last ack'd offset in `SmpProvider`, emit it on disconnect, and pass it back on reconnect.
2. **Add "Erase slot" button** — Show conditionally when slot 1 is in bad state.
3. **Enable PRN for Nordic** — After control notifications are enabled, send `RECEIPT_NOTIFICATIONS` with a reasonable value (e.g., 10-20).
