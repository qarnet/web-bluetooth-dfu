import { controller } from './app-controller.js';
import { loadFilterConfig, saveFilterConfig, isValidUuid, normalizeUuid } from './core/filter-store.js';
import { shouldDisableDfuButton } from './ui/dfu-button-state.js';

globalThis.dfuController = controller;

// ── DOM refs ─────────────────────────────────────────────────────────────────

const fileInput       = document.getElementById('file-input');
const fileLabel       = document.getElementById('file-label');
const fileNameEl      = document.getElementById('file-name');
const fileSizeEl      = document.getElementById('file-size');
const fileRow         = document.querySelector('.file-row');
const protocolBadge   = document.getElementById('protocol-badge');
const btnConnect      = document.getElementById('btn-connect');
const btnRowConnect   = document.getElementById('btn-row-connect');
const btnRowConnected = document.getElementById('btn-row-connected');
const btnRefresh      = document.getElementById('btn-refresh');
const btnSmpDiag      = document.getElementById('btn-smp-diag');
const btnSmpEcho      = document.getElementById('btn-smp-echo');
const btnSmpReset     = document.getElementById('btn-smp-reset');
const btnDisconnect   = document.getElementById('btn-disconnect');
const slotsEl         = document.getElementById('slots');
const btnDfu          = document.getElementById('btn-dfu');
const btnCancel       = document.getElementById('btn-cancel');
const btnConfirm      = document.getElementById('btn-confirm');
const btnEraseSlot    = document.getElementById('btn-erase-slot');
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

// Multi-image UI refs
const multiImageRow   = document.getElementById('multi-image-row');
const nordicBaseCheck = document.getElementById('nordic-base-check');
const nordicAppCheck  = document.getElementById('nordic-app-check');
const multiImageInfo  = document.getElementById('multi-image-info');
const transferProfileRow = document.getElementById('transfer-profile-row');
const transferProfileSelect = document.getElementById('transfer-profile-select');

// Reliable mode UI refs
const reliableModeRow   = document.getElementById('reliable-mode-row');
const reliableModeCheck = document.getElementById('reliable-mode-check');

// Firmware version display refs
const firmwareInfo    = document.getElementById('firmware-info');
const fwInfoPlanned   = document.getElementById('fw-info-planned');
const fwInfoCurrent   = document.getElementById('fw-info-current');
const fwInfoPreflight = document.getElementById('fw-info-preflight');

// ── State ────────────────────────────────────────────────────────────────────

let scanTimeoutId;
let firmwareProtocol = null;
const logHistory = [];

// ── Controller event wiring ──────────────────────────────────────────────────

controller.addEventListener('firmware-loaded', (e) => {
  const { name, size, protocol, nordicInfo, version, preflight } = e.detail;
  firmwareProtocol = protocol;
  fileNameEl.textContent = name;
  fileSizeEl.textContent = `${(size / 1024).toFixed(1)} KB`;
  showProtocol(protocol);
  updateDfuButton();

  // Show planned update version if available
  if (version) {
    firmwareInfo.style.display = '';
    fwInfoPlanned.textContent = version;
  } else if (protocol === 'nordic') {
    firmwareInfo.style.display = '';
    fwInfoPlanned.textContent = 'Nordic Secure DFU package';
  }
  fwInfoPreflight.textContent = preflight || 'n/a';

  // Nordic image-selection checkboxes
  if (protocol === 'nordic' && nordicInfo) {
    const hasBase = nordicInfo.hasBase;
    const hasApp  = nordicInfo.hasApp;
    multiImageRow.style.display = '';
    nordicBaseCheck.disabled = !hasBase;
    nordicAppCheck.disabled = !hasApp;
    nordicBaseCheck.checked = hasBase;
    nordicAppCheck.checked = hasApp;
    multiImageInfo.textContent = `Contains: ${nordicInfo.types.join(', ')}`;
    controller.setNordicImageSelection({
      base: nordicBaseCheck.checked,
      app: nordicAppCheck.checked,
    });
  } else {
    multiImageRow.style.display = 'none';
  }
  updateDfuButton();
});

controller.addEventListener('device-version', (e) => {
  fwInfoCurrent.textContent = e.detail.version || 'unknown';
});

controller.addEventListener('firmware-unloaded', () => {
  firmwareProtocol = null;
  fileNameEl.textContent = '';
  fileSizeEl.textContent = '';
  showProtocol(null);
  multiImageRow.style.display = 'none';
  nordicBaseCheck.checked = false;
  nordicBaseCheck.disabled = false;
  nordicAppCheck.checked = false;
  nordicAppCheck.disabled = false;
  firmwareInfo.style.display = 'none';
  fwInfoPlanned.textContent = '';
  fwInfoCurrent.textContent = '';
  fwInfoPreflight.textContent = '';
  updateDfuButton();
});

controller.addEventListener('connected', (e) => {
  const { deviceName, protocol, capabilities } = e.detail;
  log(`Connected to "${deviceName}"`, 'ok');
  showProtocol(protocol);
  configureUi(capabilities);
  showConnected(true);
  clearScanTimeout();
  // Hide reconnect button — valid for both manual and auto-reconnects
  btnReconnect.style.display = 'none';
  btnReconnect.textContent = 'Reconnect';
  if (capabilities.hasSlots) {
    controller.refreshSlots().catch((err) => log(err.message, 'error'));
  }
});

controller.addEventListener('disconnected', (e) => {
  const { reason } = e.detail;
  if (reason === 'device') {
    log('Device disconnected', 'error', {
      action: () => controller.connect(getFilterConfig()),
      label: 'Reconnect'
    });
  }
  if (reason === 'user') log('Disconnected', 'info');
  showConnected(false);
  updateDfuButton();
});

controller.addEventListener('log', (e) => log(e.detail.message, e.detail.level));

controller.addEventListener('progress', (e) => {
  const { currentBytes, totalBytes } = e.detail;
  setProgress(currentBytes, totalBytes);
});

controller.addEventListener('phase', (e) => setPhase(e.detail.label));

controller.addEventListener('state-changed', (e) => {
  const { state } = e.detail;
  const isBusy = ['connecting', 'uploading', 'confirming', 'disconnecting'].includes(state);
  fileLabel.classList.toggle('disabled', isBusy);
  fileInput.disabled  = isBusy;
  btnConnect.disabled = isBusy || state === 'connected';
  btnRefresh.disabled = isBusy;
  btnDisconnect.disabled = isBusy;
  btnCancel.disabled = state !== 'uploading';
  updateDfuButton();
});

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
  // Persist last successful firmware metadata for convenience
  try {
    const last = {
      name: fileNameEl.textContent,
      protocol: protocolBadge.dataset.protocol,
      version: fwInfoPlanned.textContent,
      ts: Date.now(),
    };
    localStorage.setItem('dfu-last-firmware', JSON.stringify(last));
  } catch { /* storage may be disabled */ }
});

controller.addEventListener('error', (e) => {
  const { message, recoverable, action, label } = e.detail;
  log(message, 'error', recoverable ? { action, label } : null);
});

// ── Logging ─────────────────────────────────────────────────────────────────

function log(text, level = 'info', recovery = null) {
  secLog.style.display = '';
  const ts = new Date().toLocaleTimeString();
  const isoTs = new Date().toISOString();
  const el = document.createElement('div');
  el.className = `log-${level}`;
  el.innerHTML = `<span class="log-ts">${ts}</span>${text}`;

  if (recovery && recovery.action) {
    const btn = document.createElement('button');
    btn.className = 'log-action-btn';
    btn.textContent = recovery.label || 'Retry';
    btn.addEventListener('click', () => {
      recovery.action();
      btn.disabled = true;
      btn.textContent = 'Retrying…';
    });
    el.appendChild(btn);
  }

  logEntries.appendChild(el);
  logEntries.scrollTop = logEntries.scrollHeight;
  logHistory.push({ timestamp: isoTs, level, message: String(text) });
  console.log(`[${level.toUpperCase()}] ${text}`);
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function isBusyState() {
  return ['connecting', 'uploading', 'confirming', 'disconnecting'].includes(controller.state);
}

function updateDfuButton() {
  btnDfu.disabled = shouldDisableDfuButton({
    isBusy: isBusyState(),
    hasFirmware: controller.hasFirmware,
    hasProvider: controller.hasProvider,
    firmwareProtocol,
    nordicRowVisible: multiImageRow.style.display !== 'none',
    nordicBaseChecked: nordicBaseCheck.checked,
    nordicAppChecked: nordicAppCheck.checked,
  });
}

function updateConfirmButton(enabled) {
  btnConfirm.style.display = enabled ? '' : 'none';
  btnConfirm.disabled = isBusyState() || !enabled;
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
  protocolBadge.style.display = p ? 'inline' : 'none';
  protocolBadge.dataset.protocol = providerId || '';
}

function configureUi(capabilities) {
  if (capabilities.hasSlots) {
    document.getElementById('sec-slots').style.display = '';
  } else {
    document.getElementById('sec-slots').style.display = 'none';
  }
  const isSmp = protocolBadge.dataset.protocol === 'smp';
  btnSmpDiag.style.display = isSmp ? '' : 'none';
  btnSmpEcho.style.display = isSmp ? '' : 'none';
  btnSmpReset.style.display = isSmp ? '' : 'none';
  transferProfileRow.style.display = '';
  updateConfirmButton(false);
}

function renderSlots(slots) {
  slotsEl.innerHTML = '';
  if (!slots || !slots.length) {
    slotsEl.innerHTML = '<div class="slot"><em>No slot information available</em></div>';
    btnEraseSlot.style.display = 'none';
    return;
  }
  for (const s of slots) {
    const badges = [
      s.active    ? '<span class="badge badge-green">active</span>'    : '',
      s.pending   ? '<span class="badge badge-yellow">pending</span>'  : '',
      s.confirmed ? '<span class="badge badge-blue">confirmed</span>'  : '',
    ].join('');
    const el = document.createElement('div');
    el.className = 'slot';
    el.innerHTML = `
      <div class="slot-top">
        <span class="slot-label">Slot ${s.slot}</span>
        <span class="slot-version">${s.version}</span>
        <div class="badges">${badges}</div>
      </div>
      <div class="slot-hash">${s.hash}</div>`;
    slotsEl.appendChild(el);
  }
  // Show erase button if slot 1 exists and has data (not empty)
  const slot1 = slots.find((s) => s.slot === 1);
  btnEraseSlot.style.display = (slot1 && slot1.version !== 'empty') ? '' : 'none';
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

// ── Drag and drop ────────────────────────────────────────────────────────────

['dragenter', 'dragover', 'dragleave', 'drop'].forEach((evt) => {
  fileRow.addEventListener(evt, (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
});

['dragenter', 'dragover'].forEach((evt) => {
  fileRow.addEventListener(evt, () => fileRow.classList.add('drag-active'));
});

['dragleave', 'drop'].forEach((evt) => {
  fileRow.addEventListener(evt, () => fileRow.classList.remove('drag-active'));
});

fileRow.addEventListener('drop', async (e) => {
  const file = e.dataTransfer.files[0];
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
    filterToggle.setAttribute('aria-expanded', 'true');
    updateFilterPanelVisibility();
  }
});

namePrefixInput.addEventListener('input', saveCurrentFilters);
serviceUuidInput.addEventListener('input', saveCurrentFilters);

// ── Nordic image selection checkboxes ───────────────────────────────────────

function syncNordicImageSelection() {
  controller.setNordicImageSelection({
    base: nordicBaseCheck.checked,
    app: nordicAppCheck.checked,
  });
  updateDfuButton();
}

nordicBaseCheck.addEventListener('change', syncNordicImageSelection);
nordicAppCheck.addEventListener('change', syncNordicImageSelection);

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
  startScanTimeout();
  try {
    await controller.connect(getFilterConfig());
  } catch (err) {
    // Controller emits recoverable-error with retry action; don't duplicate log here
    showConnected(false);
  }
});

// ── Disconnect ───────────────────────────────────────────────────────────────

btnDisconnect.addEventListener('click', () => {
  controller.disconnect();
  log('Disconnected');
});

// ── Refresh slots ──────────────────────────────────────────────────────────

btnRefresh.addEventListener('click', async () => {
  try { await controller.refreshSlots(); } catch (err) { log(err.message, 'error'); }
});

// ── DFU ────────────────────────────────────────────────────────────────────────

btnDfu.addEventListener('click', async () => {
  btnDfu.textContent = 'Updating…';
  progressWrap.style.display = '';

  try {
    await controller.runUpdate();
  } catch (err) {
    log(err.message, 'error');
    btnDfu.textContent = 'Update Firmware';
  } finally {
    setProgress(0, 0);
    updateDfuButton();
  }
});

btnCancel.addEventListener('click', () => {
  controller.cancel();
  log('Upload cancelled', 'warn');
  btnDfu.textContent = 'Update Firmware';
  btnCancel.disabled = true;
});

btnEraseSlot.addEventListener('click', async () => {
  btnEraseSlot.disabled = true;
  try {
    await controller.eraseSlot();
    log('Slot 1 erased', 'ok');
  } catch (err) {
    log(err.message, 'error');
  } finally {
    btnEraseSlot.disabled = false;
  }
});

// Reliable mode toggle
reliableModeCheck.addEventListener('change', () => {
  controller.setReliableMode(reliableModeCheck.checked);
});

transferProfileSelect.addEventListener('change', () => {
  controller.setTransferProfile(transferProfileSelect.value);
  log(`Transfer profile: ${transferProfileSelect.value}`, 'info');
});

// ── Confirm ─────────────────────────────────────────────────────────────────

btnConfirm.addEventListener('click', async () => {
  btnConfirm.textContent = 'Confirming…';
  try {
    await controller.confirm();
    log('Slot 0 is now active + confirmed — DFU is complete.', 'ok');
    btnConfirm.textContent = 'Confirmed ✓';
  } catch (err) {
    log(err.message, 'error');
    btnConfirm.textContent = 'Confirm Update';
  } finally {
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
  }
});

btnSmpEcho.addEventListener('click', async () => {
  try {
    const rsp = await controller.smpEcho('ping');
    log(`SMP echo OK: ${rsp?.r || rsp?.d || 'pong'}`, 'ok');
  } catch (err) {
    log(err.message, 'error');
  }
});

btnSmpDiag.addEventListener('click', async () => {
  try {
    await controller.refreshSlots();
    log('SMP diagnostics refreshed (image slot state).', 'ok');
  } catch (err) {
    log(err.message, 'error');
  }
});

btnSmpReset.addEventListener('click', async () => {
  try {
    await controller.resetDevice();
    log('Reset command sent', 'warn');
  } catch (err) {
    log(err.message, 'error');
  }
});

// ── Log export ─────────────────────────────────────────────────────────────

const btnCopyLog     = document.getElementById('btn-copy-log');
const btnDownloadLog = document.getElementById('btn-download-log');
const btnDownloadLogJson = document.getElementById('btn-download-log-json');

function getLogText() {
  return Array.from(logEntries.children)
    .map((el) => el.textContent.replace('Retrying…', '').trim())
    .join('\n');
}

btnCopyLog.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(getLogText());
    btnCopyLog.textContent = 'Copied!';
    setTimeout(() => btnCopyLog.textContent = 'Copy logs', 1500);
  } catch {
    log('Clipboard write failed', 'warn');
  }
});

btnDownloadLog.addEventListener('click', () => {
  const blob = new Blob([getLogText()], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `dfu-log-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt`;
  a.click();
  URL.revokeObjectURL(url);
});

btnDownloadLogJson.addEventListener('click', () => {
  const payload = {
    exportedAt: new Date().toISOString(),
    firmwareProtocol,
    entries: logHistory,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `dfu-log-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

// ── Initial state ───────────────────────────────────────────────────────────

btnReconnect.style.display = 'none';
transferProfileRow.style.display = 'none';
controller.setTransferProfile(transferProfileSelect.value);
restoreFilters();
