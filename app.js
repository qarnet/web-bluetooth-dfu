import { connectToDevice } from './bluetooth/connect.js';
import { SmpProvider } from './smp/smp-provider.js';
import { NordicProvider } from './nordic/nordic-provider.js';
import { detectFromFile, detectFromDevice, resolveProtocol } from './core/detect.js';

const PROVIDERS = {
  smp: SmpProvider,
  nordic: NordicProvider,
};

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

// ── State ─────────────────────────────────────────────────────────────────────

let firmware   = null;
let fileSig    = null;   // 'smp' | 'nordic' | null
let connection = null;   // { device, server, services, disconnect }
let provider   = null;   // DfuProvider instance
let busy       = false;

// ── Logging ───────────────────────────────────────────────────────────────────

function log(text, level = 'info') {
  secLog.style.display = '';
  const ts = new Date().toLocaleTimeString();
  const el = document.createElement('div');
  el.className = `log-${level}`;
  el.innerHTML = `<span class="log-ts">${ts}</span>${text}`;
  logEntries.appendChild(el);
  logEntries.scrollTop = logEntries.scrollHeight;
  console.log(`[${level.toUpperCase()}] ${text}`);
}

// ── UI helpers ─────────────────────────────────────────────────────────────────

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
  btnDfu.disabled = busy || !firmware || !provider;
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
    slotsEl.innerHTML = '<div class="slot"><em>No slot information available</em></div>';
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
}

function checkPending(slots) {
  const s0 = slots.find((s) => s.slot === 0);
  // After a test-mode swap, MCUboot reports the new primary image as
  // active=true, confirmed=false (the `pending` trailer flag lived on the
  // secondary slot pre-swap and is cleared once the swap completes).
  // Treat any active-but-unconfirmed image as awaiting confirmation.
  if (s0 && s0.active && !s0.confirmed) {
    log('New image is active but not yet confirmed — if the device reboots now it will revert. Click "Confirm" to make it permanent.', 'warn');
    updateConfirmButton(true);
  } else {
    updateConfirmButton(false);
  }
}

// ── File picker ────────────────────────────────────────────────────────────────

fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  if (!file) return;

  try {
    const data = new Uint8Array(await file.arrayBuffer());
    fileSig = detectFromFile(data);
    if (fileSig) showProtocol(fileSig);

    // Pre-load into whatever provider will be used
    let targetProvider = PROVIDERS[fileSig];
    if (!targetProvider) targetProvider = SmpProvider; // default guess

    firmware = { data, file };
    fileNameEl.textContent = file.name;
    fileSizeEl.textContent = `${(data.byteLength / 1024).toFixed(1)} KB`;
    chunkRow.style.display = '';
    log(`Loaded ${file.name} (${(data.byteLength / 1024).toFixed(1)} KB)`, 'ok');
  } catch (err) {
    log(err.message, 'error');
    firmware = null;
    fileSig = null;
    fileNameEl.textContent = '';
    showProtocol(null);
  }
  updateDfuButton();
});

// ── Connect ────────────────────────────────────────────────────────────────────

btnConnect.addEventListener('click', async () => {
  setBusy(true);
  btnConnect.textContent = 'Connecting…';
  try {
    connection = await connectToDevice(onDeviceDisconnect);
    log(`Connected to "${connection.device.name ?? 'Unknown'}"`, 'ok');

    const deviceSig = detectFromDevice(connection.services);
    const proto = resolveProtocol(fileSig, deviceSig);

    const ProviderClass = PROVIDERS[proto];
    if (!ProviderClass) throw new Error(`Unknown protocol: ${proto}`);

    showProtocol(proto);
    provider = new ProviderClass({ mtu: parseInt(chunkSizeInput.value, 10) || 128 });
    configureUi(ProviderClass.capabilities);

    provider.addEventListener('log', (e) => log(e.detail.message, e.detail.level));
    provider.addEventListener('progress', (e) => {
      const { currentBytes, totalBytes } = e.detail;
      setProgress(currentBytes, totalBytes);
    });
    provider.addEventListener('phase', (e) => setPhase(e.detail.label));
    provider.addEventListener('needs-reconnect', () => {
      log('Device rebooted. Please click Reconnect when it advertises again.', 'warn');
      showConnected(false);
      if (provider) provider.detach().catch(() => {});
      connection = null;
      btnReconnect.style.display = '';
      btnReconnect.disabled = false;
      updateDfuButton();
    });

    await provider.attach(connection);
    showConnected(true);
    await refreshSlots();
  } catch (err) {
    log(err.message, 'error');
    showConnected(false);
    connection = null;
    provider = null;
  } finally {
    btnConnect.textContent = 'Scan & Connect';
    setBusy(false);
  }
});

function onDeviceDisconnect() {
  log('Device disconnected', 'error');
  showConnected(false);
  connection = null;
  provider = null;
  updateDfuButton();
  updateConfirmButton(false);
  progressWrap.style.display = 'none';
}

// ── Disconnect ─────────────────────────────────────────────────────────────────

btnDisconnect.addEventListener('click', () => {
  connection?.disconnect();
  connection = null;
  provider?.detach().catch(() => {});
  provider = null;
  showConnected(false);
  slotsEl.innerHTML = '';
  updateDfuButton();
  updateConfirmButton(false);
  log('Disconnected');
});

// ── Refresh slots ──────────────────────────────────────────────────────────────

btnRefresh.addEventListener('click', async () => {
  setBusy(true);
  try { await refreshSlots(); } finally { setBusy(false); }
});

async function refreshSlots() {
  if (!provider) return;
  log('Listing images…');
  const slots = await provider.readState();
  renderSlots(slots);
  if (slots.length) checkPending(slots);
  log(`Found ${slots.length} image slot(s)`, 'ok');
}

// ── DFU ────────────────────────────────────────────────────────────────────────

btnDfu.addEventListener('click', async () => {
  if (!firmware || !provider) return;

  setBusy(true);
  btnDfu.textContent = 'Updating…';
  progressWrap.style.display = '';
  setProgress(0, firmware.data.byteLength);

  try {
    await provider.loadFirmware(firmware.data);
    const result = await provider.runUpdate();

    if (result?.needsConfirm) {
      // SMP flow: reset happened, need reconnect + confirm
      // UI already handled by 'needs-reconnect' event
    } else {
      log('Update complete', 'ok');
      btnDfu.textContent = 'Done ✓';
    }
  } catch (err) {
    log(err.message, 'error');
    btnDfu.textContent = 'Update Firmware';
  } finally {
    setProgress(0, 0);
    setBusy(false);
    updateDfuButton();
  }
});

// ── Confirm (SMP only, reconnect after reset) ──────────────────────────────────

btnConfirm.addEventListener('click', async () => {
  if (!provider) return;
  setBusy(true);
  btnConfirm.textContent = 'Confirming…';
  try {
    log('Confirming image to make swap permanent…');
    await provider.confirm();

    const slots = await provider.readState();
    renderSlots(slots);
    checkPending(slots);
    if (slots.find((s) => s.slot === 0)?.confirmed) {
      log('Slot 0 is now active + confirmed — DFU is complete.', 'ok');
      btnConfirm.textContent = 'Confirmed ✓';
    } else {
      log('Slot 0 is still not confirmed after confirm command.', 'warn');
      btnConfirm.textContent = 'Confirm Update';
    }
  } catch (err) {
    log(err.message, 'error');
  } finally {
    setBusy(false);
    updateDfuButton();
  }
});

// ── Reconnect (Nordic buttonless or SMP reset) ───────────────────────────────

btnReconnect.addEventListener('click', async () => {
  btnReconnect.disabled = true;
  btnReconnect.textContent = 'Reconnecting…';
  try {
    connection = await connectToDevice(onDeviceDisconnect);
    const deviceSig = detectFromDevice(connection.services);
    const proto = resolveProtocol(fileSig, deviceSig);
    const ProviderClass = PROVIDERS[proto];
    provider = new ProviderClass({ mtu: parseInt(chunkSizeInput.value, 10) || 128 });
    showProtocol(proto);
    configureUi(ProviderClass.capabilities);

    provider.addEventListener('log', (e) => log(e.detail.message, e.detail.level));
    provider.addEventListener('progress', (e) => setProgress(e.detail.currentBytes, e.detail.totalBytes));
    provider.addEventListener('phase', (e) => setPhase(e.detail.label));
    provider.addEventListener('needs-reconnect', () => {
      log('Device rebooted again. Please reconnect.', 'warn');
      showConnected(false);
      btnReconnect.style.display = '';
      btnReconnect.disabled = false;
    });

    await provider.attach(connection);
    showConnected(true);
    await refreshSlots();
    btnReconnect.style.display = 'none';
    btnReconnect.textContent = 'Reconnect';
  } catch (err) {
    log(err.message, 'error');
    btnReconnect.disabled = false;
  } finally {
    setBusy(false);
  }
});

// ── Initial state ──────────────────────────────────────────────────────────────

btnReconnect.style.display = 'none';
