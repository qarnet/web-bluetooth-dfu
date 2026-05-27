# Implementation Plan

This plan prioritizes reliability and useful operator features without adding a build step or runtime dependencies.

## Phase 1 - Ship-next essentials

1. Nordic image-level selection (base/app/both) in UI.
2. Deterministic reconnect ownership for Nordic continuation (manual reconnect only).
3. Better postmortem artifacts for field debugging (structured logs).
4. Test coverage for image selection and DFU button enable/disable state.

Status:

- [x] Nordic image-level selection shipped.
- [x] Reconnect ownership simplified to manual reconnect flow.
- [x] Structured JSON log export added.
- [x] Tests added for image selection + button-state logic.

## Phase 2 - Reliability hardening

1. Continuation retry policy for Nordic reconnect windows:
   - short settle delay before first control op,
   - bounded SELECT retry with backoff,
   - explicit transition to reconnect-required when control path is silent.
2. Optional transport profiles:
   - conservative (safer, slower),
   - balanced (default),
   - aggressive (fastest).
3. Add browser E2E assertions around continuation retry states.

Status:

- [x] Continuation readiness retry/backoff policy implemented.
- [x] Transfer profiles implemented (conservative/balanced/aggressive).
- [x] Browser E2E reconnect/continuation assertions updated.

## Phase 3 - SMP power-user features

1. Expose optional SMP utility commands in UI (echo/ping style check, reset shortcut).
2. Add read-only diagnostics for available mcumgr groups when supported.
3. Improve rc error translation and remediation hints.

Status:

- [x] SMP utility commands added in UI (echo/reset).
- [x] Read-only diagnostics actions added (slot refresh + diagnostics shortcut).
- [x] RC translation hints are present and kept in provider mapping.

## Phase 4 - Product polish

1. Preflight panel for firmware metadata (version/hash/slot target) before upload.
2. Session export bundle (`.json`) including environment + protocol decisions.
3. Expand docs with troubleshooting decision tree per protocol.

Status:

- [x] Preflight metadata panel added.
- [x] Session JSON export now includes protocol decisions and timestamps.
- [x] Troubleshooting decision tree added.
