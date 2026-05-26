# Troubleshooting

## Quick decision tree

1. Cannot connect?
   - Check browser support (Chrome/Edge desktop/Android only).
   - Ensure HTTPS or localhost.
   - Re-open scan filters and enable broad scan.

2. SMP upload stalls or times out?
   - Switch transfer profile to **Conservative**.
   - Enable **Reliable mode**.
   - Reconnect and retry upload.

3. Nordic continuation fails after base image?
   - Reconnect and retry (expected in some setups during flash erase windows).
   - Keep **Balanced** or **Conservative** profile.
   - Try app-only or base-only using image selection checkboxes.

4. Need diagnostics for support?
   - Export logs as text and JSON from the Log section.
   - Include browser, OS, adapter, package name, and selected profile.

## Transfer profiles

- **Balanced**: default behavior for most devices.
- **Conservative**: safer retries and slower pacing.
- **Aggressive**: fastest, least forgiving.
