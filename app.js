import { connectToDevice } from './bluetooth/connect.js';
import { SmpClient } from './smp/protocol.js';
import { validateImage, listImages, uploadFirmware, testImage, resetDevice } from './smp/image.js';

// ── DOM refs ─────────────────────────────────────────────────────────────────

const fileInput       = document.getElementById('file-input');
const fileLabel       = document.getElementById('file-label');
const fileNameEl      = document.getElementById('file-name');
const fileSizeEl      = document.getElementById('file-size');
const chunkRow        = document.getElementById('chunk-row');
const chunkSizeInput  = document.getElementById('chunk-size');
const btnConnect      = document.getElementById('btn-connect');
const btnRowConnect   = document.getElementById('btn-row-connect');
const btnRowConnected = document.getElementById('btn-row-connected');
const btnRefresh      = document.getElementById('btn-refresh');
const btnDisconnect   = document.getElementById('btn-disconnect');
const slotsEl         = document.getElementById('slots');
const btnDfu          = document.getElementById('btn-dfu');
const progressWrap    = document.getElementById('progress-wrap');
const progressFill    = document.getElementById('progress-fill');
const progressText    = document.getElementById('progress-text');
const secLog          = document.getElementById('sec-log');
const logEntries      = document.getElementById('log-entries');

// ── State ─────────────────────────────────────────────────────────────────────

let firmware   = null;   // Uint8Array
let connection = null;   // { device, server, characteristic, disconnect }
let client     = null;   // SmpClient
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
  btnDfu.disabled = busy || !firmware || !client;
}

function showConnected(isConnected) {
  btnRowConnect.style.display   = isConnected ? 'none' : '';
  btnRowConnected.style.display = isConnected ? '' : 'none';
}

function renderSlots(slots) {
  slotsEl.innerHTML = '';
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

function setProgress(offset, total) {
  progressWrap.style.display = '';
  const pct = total ? Math.round((offset / total) * 100) : 0;
  progressFill.style.width = `${pct}%`;
  progressText.textContent  = `${(offset / 1024).toFixed(1)} / ${(total / 1024).toFixed(1)} KB`;
}

// ── File picker ────────────────────────────────────────────────────────────────

fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const data = new Uint8Array(reader.result);
    try {
      validateImage(data);
      firmware = data;
      fileNameEl.textContent = file.name;
      fileSizeEl.textContent = `${(data.byteLength / 1024).toFixed(1)} KB`;
      chunkRow.style.display = '';
      log(`Loaded ${file.name} (${(data.byteLength / 1024).toFixed(1)} KB)`, 'ok');
    } catch (err) {
      log(err.message, 'error');
      firmware = null;
      fileNameEl.textContent = '';
      chunkRow.style.display = 'none';
    }
    updateDfuButton();
  };
  reader.readAsArrayBuffer(file);
});

// ── Connect ────────────────────────────────────────────────────────────────────

btnConnect.addEventListener('click', async () => {
  setBusy(true);
  btnConnect.textContent = 'Connecting…';
  try {
    connection = await connectToDevice(onDeviceDisconnect);
    log(`Connected to "${connection.device.name ?? 'Unknown'}"`, 'ok');

    client = new SmpClient(connection.characteristic);
    await client.start();

    showConnected(true);
    await refreshSlots();
  } catch (err) {
    log(err.message, 'error');
    connection = null;
    client = null;
    showConnected(false);
  } finally {
    btnConnect.textContent = 'Scan & Connect';
    setBusy(false);
  }
});

function onDeviceDisconnect() {
  log('Device disconnected', 'error');
  connection = null;
  client = null;
  showConnected(false);
  updateDfuButton();
  progressWrap.style.display = 'none';
}

// ── Disconnect ─────────────────────────────────────────────────────────────────

btnDisconnect.addEventListener('click', () => {
  connection?.disconnect();
  connection = null;
  client = null;
  showConnected(false);
  slotsEl.innerHTML = '';
  updateDfuButton();
  log('Disconnected');
});

// ── Refresh slots ──────────────────────────────────────────────────────────────

btnRefresh.addEventListener('click', async () => {
  setBusy(true);
  try { await refreshSlots(); } finally { setBusy(false); }
});

async function refreshSlots() {
  log('Listing images…');
  const slots = await listImages(client);
  renderSlots(slots);
  log(`Found ${slots.length} image slot(s)`, 'ok');
  return slots;
}

// ── DFU ────────────────────────────────────────────────────────────────────────

btnDfu.addEventListener('click', async () => {
  if (!firmware || !client) return;
  const chunkSize = parseInt(chunkSizeInput.value, 10) || 128;

  setBusy(true);
  btnDfu.textContent = 'Uploading…';
  progressWrap.style.display = '';
  setProgress(0, firmware.byteLength);

  try {
    log(`Uploading firmware (${(firmware.byteLength / 1024).toFixed(1)} KB, chunk=${chunkSize}B)…`);
    await uploadFirmware(client, firmware, ({ offset, total }) => {
      setProgress(offset, total);
      btnDfu.textContent = `Uploading… ${Math.round((offset / total) * 100)}%`;
    }, chunkSize);
    log('Upload complete', 'ok');

    log('Refreshing image list…');
    const slots = await listImages(client);
    renderSlots(slots);

    const slot1 = slots.find((s) => s.slot === 1);
    if (!slot1) throw new Error('Slot 1 not found after upload');

    btnDfu.textContent = 'Marking for test…';
    log(`Marking image for test (${slot1.hash.slice(0, 12)}…)…`);
    await testImage(client, slot1.hash);
    log('Image marked for test', 'ok');

    btnDfu.textContent = 'Resetting…';
    log('Resetting device — will swap and boot new firmware…');
    await resetDevice(client);
    log('Reset sent. Reconnect after boot to verify.', 'ok');
    btnDfu.textContent = 'Done ✓';
  } catch (err) {
    log(err.message, 'error');
    btnDfu.textContent = 'Flash Firmware';
  } finally {
    setBusy(false);
    updateDfuButton();
  }
});
