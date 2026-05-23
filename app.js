import { controller } from './app-controller.js';
import { loadFilterConfig, saveFilterConfig, isValidUuid, normalizeUuid } from './core/filter-store.js';

// ── DOM refs ─────────────────────────────────────────────────────────────────

const fileInput       = document.getElementById('file-input');
const fileLabel       = document.getElementById('file-label');
const fileNameEl      = document.getElementById('file-name');
const fileSizeEl      = document.getElementById('file-size');
const chunkRow        = document.getElementById('chunk-row');
const chunkSizeInput  = document.getElementById('chunk-size');
const protocolBadge   = document.getElementById('protocol-badge');
const btnConnect      = document.getElementById('btn-connect');
const btnRowConnect   = document.getElementById('btn-row-connect');
const btnRowConnected = document.getElementById('btn-row-connected');
const btnRefresh      = document.getElementById('btn-refresh');
const btnDisconnect   = document.getElementById('btn-disconnect');
const slotsEl         = document.getElementById('slots');
const btnDfu          = document.getElementById('btn-dfu');
const btnConfirm      = document.getElementById('btn-confirm');
const btnReconnect    = document.getElementById('btn-reconnect');
const progressWrap    = document.getElementById('progress-wrap');
const progressFill    = document.getElementById('progress-fill');
const progressText    = document.getElementById('progress-text');
const secLog          = document.getElementById('sec-log');
const logEntries      = document.getElementById('log-entries');

// Filter UI refs (created in index.html)
const filterToggle    = document.getElementById('filter-toggle');
const filterPanel     = document.getElementById('filter-panel');
const scanAllCheck    = document.getElementById('scan-all');
const namePrefixInput = document.getElementById('name-prefix');
const serviceUuidInput= document.getElementById('service-uuid');

// ── State ────────────────────────────────────────────────────────────────────

let busy = false;
let scanTimeoutId = null;

// ── Controller event wiring ──────────────────────────────────────────────────

controller.addEventListener('firmware-loaded', (e) => {
  const { name, size, protocol } = e.detail;
  fileNameEl.textContent = name;
  fileSizeEl.textContent = `${(size / 1024).toFixed(1)} KB`;
  chunkRow.style.display = '';
  showProtocol(protocol);
  log(`Loaded ${name} (${(size / 1024).toFixed(1)} KB)`, 'ok');
  updateDfuButton();
});

controller.addEventListener('firmware-unloaded', () => {
  fileNameEl.textContent = '';
  fileSizeEl.textContent = '';
  chunkRow.style.display = 'none';
  showProtocol(null);
  updateDfuButton();
});

controller.addEventListener('connected', (e) => {
  const { deviceName, protocol, capabilities } = e.detail;
  log(`Connected to "${deviceName}"`, 'ok');
  showProtocol(protocol);
  configureUi(capabilities);
  showConnected(true);
  clearScanTimeout();
  // For SMP: immediately read slots so checkPending() runs and the confirm
  // button appears when a post-reboot image is active but unconfirmed.
  if (capabilities.hasSlots) {
    controller.refreshSlots().catch((err) => log(err.message, 'error'));
  }
});

controller.addEventListener('disconnected', (e) => {
  const { reason } = e.detail;
  if (reason === 'device') log('Device disconnected', 'error');
  showConnected(false);
  slotsEl.innerHTML = '';
  updateDfuButton();
  updateConfirmButton(false);
  progressWrap.style.display = 'none';
});

controller.addEventListener('log', (e) => log(e.detail.message, e.detail.level));

controller.addEventListener('progress', (e) => {
  const { currentBytes, totalBytes } = e.detail;
  setProgress(currentBytes, totalBytes);
});

controller.addEventListener('phase', (e) => setPhase(e.detail.label));

controller.addEventListener('needs-reconnect', () => {
  log('Device rebooted. Please click Reconnect when it advertises again.', 'warn');
  showConnected(false);
  btnReconnect.style.display = '';
  btnReconnect.disabled = false;
  updateDfuButton();
});

controller.addEventListener('slots-updated', (e) => {
  const { slots } = e.detail;
  renderSlots(slots);
  if (slots.length) checkPending(slots);
  log(`Found ${slots.length} image slot(s)`, 'ok');
});

controller.addEventListener('update-complete', () => {
  log('Update complete', 'ok');
  btnDfu.textContent = 'Done ✓';
});

controller.addEventListener('error', (e) => {
  log(e.detail.message, 'error');
});

// ── Logging ─────────────────────────────────────────────────────────────────

function log(text, level = 'info') {
  secLog.style.display = '';
  const ts = new Date().toLocaleTimeString();
  const el = document.createElement('div');
  el.className = `log-${level}`;
  el.innerHTML = `\u003cspan class="log-ts"\u003e${ts}\u003c/span\u003e${text}`;
  logEntries.appendChild(el);
  logEntries.scrollTop = logEntries.scrollHeight;
  console.log(`[${level.toUpperCase()}] ${text}`);
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function setBusy(state) {
  busy = state;
  fileLabel.classList.toggle('disabled', state);
  fileInput.disabled  = state;
  btnConnect.disabled = state;
  btnRefresh.disabled = state;
  btnDisconnect.disabled = state;
  chunkSizeInput.disabled = state;
  updateDfuButton();
}

function updateDfuButton() {
  btnDfu.disabled = busy || !controller.hasFirmware || !controller.hasProvider;
}

function updateConfirmButton(enabled) {
  btnConfirm.style.display = enabled ? '' : 'none';
  btnConfirm.disabled = busy || !enabled;
}

function showConnected(isConnected) {
  btnRowConnect.style.display   = isConnected ? 'none' : '';
  btnRowConnected.style.display = isConnected ? '' : 'none';
}

function setProgress(offset, total) {
  progressWrap.style.display = '';
  const pct = total ? Math.round((offset / total) * 100) : 0;
  progressFill.style.width = `${pct}%`;
  progressText.textContent  = `${(offset / 1024).toFixed(1)} / ${(total / 1024).toFixed(1)} KB`;
}

function setPhase(label) {
  btnDfu.textContent = label;
}

function showProtocol(providerId) {
  const p = providerId === 'smp' ? 'SMP / MCUboot' : providerId === 'nordic' ? 'Nordic Secure DFU' : '';
  protocolBadge.textContent = p;
  protocolBadge.style.display = p ? '' : 'none';
}

function configureUi(capabilities) {
  if (capabilities.hasSlots) {
    document.getElementById('sec-slots').style.display = '';
  } else {
    document.getElementById('sec-slots').style.display = 'none';
  }
  updateConfirmButton(false);
  if (capabilities.chunkConfigurable) {
    chunkRow.style.display = '';
  } else {
    chunkRow.style.display = 'none';
  }
}

function renderSlots(slots) {
  slotsEl.innerHTML = '';
  if (!slots || !slots.length) {
    slotsEl.innerHTML = '\u003cdiv class="slot"\u003e\u003cem\u003eNo slot information available\u003c/em\u003e\u003c/div\u003e';
    return;
  }
  for (const s of slots) {
    const badges = [
      s.active    ? '\u003cspan class="badge badge-green"\u003eactive\u003c/span\u003e'    : '',
      s.pending   ? '\u003cspan class="badge badge-yellow"\u003epending\u003c/span\u003e'  : '',
      s.confirmed ? '\u003cspan class="badge badge-blue"\u003econfirmed\u003c/span\u003e'  : '',
    ].join('');
    const el = document.createElement('div');
    el.className = 'slot';
    el.innerHTML = `
      \u003cdiv class="slot-top"\u003e
        \u003cspan class="slot-label"\u003eSlot ${s.slot}\u003c/span\u003e
        \u003cspan class="slot-version"\u003e${s.version}\u003c/span\u003e
        \u003cdiv class="badges"\u003e${badges}\u003c/div\u003e
      \u003c/div\u003e
      \u003cdiv class="slot-hash"\u003e${s.hash}\u003c/div\u003e`;
    slotsEl.appendChild(el);
  }
}

function checkPending(slots) {
  const s0 = slots.find((s) => s.slot === 0);
  if (s0 && s0.active && !s0.confirmed) {
    log('New image is active but not yet confirmed — if the device reboots now it will revert. Click "Confirm" to make it permanent.', 'warn');
    updateConfirmButton(true);
  } else {
    updateConfirmButton(false);
  }
}

// ── File picker ──────────────────────────────────────────────────────────────

fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  if (!file) return;

  try {
    await controller.loadFirmware(file);
  } catch (err) {
    log(err.message, 'error');
    controller.unloadFirmware();
  }
});

// ── Filter UI ────────────────────────────────────────────────────────────────

function restoreFilters() {
  const cfg = loadFilterConfig();
  scanAllCheck.checked = cfg.scanAll;
  namePrefixInput.value = cfg.namePrefix;
  serviceUuidInput.value = cfg.serviceUuid;
  updateFilterPanelVisibility();
}

function getFilterConfig() {
  return {
    scanAll: scanAllCheck.checked,
    namePrefix: namePrefixInput.value.trim(),
    serviceUuid: normalizeUuid(serviceUuidInput.value.trim()),
  };
}

function saveCurrentFilters() {
  saveFilterConfig(getFilterConfig());
}

function updateFilterPanelVisibility() {
  const expanded = filterToggle.getAttribute('aria-expanded') === 'true';
  filterPanel.style.display = expanded ? 'flex' : 'none';
  filterToggle.textContent = expanded ? 'Filters ▲' : 'Filters ▼';
}

filterToggle.addEventListener('click', () => {
  const expanded = filterToggle.getAttribute('aria-expanded') === 'true';
  filterToggle.setAttribute('aria-expanded', String(!expanded));
  updateFilterPanelVisibility();
});

scanAllCheck.addEventListener('change', () => {
  saveCurrentFilters();
  if (!scanAllCheck.checked) {
    // If user unchecked "scan all", auto-expand the panel so they can set filters
    filterToggle.setAttribute('aria-expanded', 'true');
    updateFilterPanelVisibility();
  }
});

namePrefixInput.addEventListener('input', saveCurrentFilters);
serviceUuidInput.addEventListener('input', saveCurrentFilters);

function triggerFilterAttention() {
  filterPanel.classList.add('filter-attention');
  filterToggle.setAttribute('aria-expanded', 'true');
  updateFilterPanelVisibility();
  setTimeout(() => filterPanel.classList.remove('filter-attention'), 2000);
}

// ── Scan timeout / no-device-found hint ──────────────────────────────────────

function startScanTimeout() {
  clearScanTimeout();
  scanTimeoutId = setTimeout(() => {
    if (!controller.isConnected) {
      triggerFilterAttention();
      log('No device selected. Try adjusting the filter options.', 'warn');
    }
  }, 3000);
}

function clearScanTimeout() {
  if (scanTimeoutId) { clearTimeout(scanTimeoutId); scanTimeoutId = null; }
}

// ── Connect ─────────────────────────────────────────────────────────────────

btnConnect.addEventListener('click', async () => {
  setBusy(true);
  btnConnect.textContent = 'Connecting…';
  startScanTimeout();

  try {
    await controller.connect(getFilterConfig());
  } catch (err) {
    log(err.message, 'error');
    showConnected(false);
  } finally {
    btnConnect.textContent = 'Scan & Connect';
    setBusy(false);
  }
});

// ── Disconnect ───────────────────────────────────────────────────────────────

btnDisconnect.addEventListener('click', () => {
  controller.disconnect();
  log('Disconnected');
});

// ── Refresh slots ──────────────────────────────────────────────────────────

btnRefresh.addEventListener('click', async () => {
  setBusy(true);
  try { await controller.refreshSlots(); } catch (err) { log(err.message, 'error'); }
  finally { setBusy(false); }
});

// ── DFU ────────────────────────────────────────────────────────────────────────

btnDfu.addEventListener('click', async () => {
  setBusy(true);
  btnDfu.textContent = 'Updating…';
  progressWrap.style.display = '';

  try {
    await controller.runUpdate();
  } catch (err) {
    log(err.message, 'error');
    btnDfu.textContent = 'Update Firmware';
  } finally {
    setProgress(0, 0);
    setBusy(false);
    updateDfuButton();
  }
});

// ── Confirm ─────────────────────────────────────────────────────────────────

btnConfirm.addEventListener('click', async () => {
  setBusy(true);
  btnConfirm.textContent = 'Confirming…';
  try {
    await controller.confirm();
    log('Slot 0 is now active + confirmed — DFU is complete.', 'ok');
    btnConfirm.textContent = 'Confirmed ✓';
  } catch (err) {
    log(err.message, 'error');
    btnConfirm.textContent = 'Confirm Update';
  } finally {
    setBusy(false);
    updateDfuButton();
  }
});

// ── Reconnect ───────────────────────────────────────────────────────────────

btnReconnect.addEventListener('click', async () => {
  btnReconnect.disabled = true;
  btnReconnect.textContent = 'Reconnecting…';
  try {
    await controller.reconnect(getFilterConfig());
    btnReconnect.style.display = 'none';
    btnReconnect.textContent = 'Reconnect';
  } catch (err) {
    log(err.message, 'error');
    btnReconnect.disabled = false;
  } finally {
    setBusy(false);
  }
});

// ── Initial state ───────────────────────────────────────────────────────────

btnReconnect.style.display = 'none';
restoreFilters();
