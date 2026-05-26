import { DfuProvider } from '../core/provider.js';
import { MCUManager } from './mcumgr.js';

function bufToHex(buf) {
  return Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fmtVersion(v) {
  return (typeof v === 'string' && v) ? v : 'unknown';
}

export class SmpProvider extends DfuProvider {
  static get id()    { return 'smp'; }
  static get label() { return 'SMP / MCUboot'; }
  static get capabilities() {
    return {
      hasSlots: true,
      hasConfirmStep: true,
      hasTestStep: true,
      chunkConfigurable: true,
      multiObject: false,
      hasCancel: true,
    };
  }

  static _rcMessages = {
    1: 'Unknown error',
    2: 'Slot is busy or in bad state',
    3: 'Invalid value',
    4: 'Operation timeout',
    5: 'No entry found',
    6: 'Bad state',
    7: 'Response too large',
    8: 'Not supported',
    9: 'Data is corrupt',
    10: 'Device is busy',
  };

  static _fmtRc(rc, context = 'SMP') {
    const msg = SmpProvider._rcMessages[rc] || `Device returned error code ${rc}`;
    return `${context} failed: ${msg}`;
  }

  /** @param {object} opts */
  constructor(opts = {}) {
    super();
    this._mcuMgr = null;
    this._mtu = opts.mtu || 244;
    this._firmware = null;
    this._resumeOffset = 0;
    this._transferProfile = 'balanced';
  }

  async attach(session) {
    const characteristic = session.services
      .get('8d53dc1d-1db7-4cd3-868b-8a527460aa84')
      ?.characteristics.get('da2e7828-fbce-4e01-ae9e-261174997c48');
    if (!characteristic) throw new Error('SMP characteristic not found');

    this._mcuMgr = new MCUManager({
      characteristic,
      mtu: this._mtu,
      logger: { info: (...a) => this.emit('log', { message: a.join(' '), level: 'info' }),
                error: (...a) => this.emit('log', { message: a.join(' '), level: 'error' }) },
    });
    await this._mcuMgr.start();
    this._applyTransferProfile();
  }

  async detach() {
    if (this._mcuMgr) {
      await this._mcuMgr.stop();
      this._mcuMgr = null;
    }
  }

  cancel() {
    this._mcuMgr?.cancelUpload();
  }

  setReliableMode(enabled) {
    this._mcuMgr?.setReliableMode(enabled);
  }

  setTransferProfile(profile) {
    this._transferProfile = profile || 'balanced';
    this._applyTransferProfile();
  }

  async echo(text = 'ping') {
    if (!this._mcuMgr) throw new Error('Manager not attached');
    const msg = await this._sendAndWait((done) => {
      this._mcuMgr.onMessage((m) => {
        if (m.op === 3 && m.group === 0 && m.id === 0) done(m.data);
      });
      this._mcuMgr.cmdEcho(text);
    }, 10000);
    return msg;
  }

  async deviceReset() {
    if (!this._mcuMgr) throw new Error('Manager not attached');
    try {
      await this._mcuMgr.cmdReset();
    } catch {
      // Reset may disconnect before response.
    }
  }

  _applyTransferProfile() {
    if (!this._mcuMgr) return;
    const profile = this._transferProfile;
    if (profile === 'conservative') {
      this._mcuMgr.configureTransport({ mtu: 128, chunkTimeout: 8000, maxConsecutiveTimeouts: 3, maxTotalTimeouts: 8, reliableMode: true });
    } else if (profile === 'aggressive') {
      this._mcuMgr.configureTransport({ mtu: 244, chunkTimeout: 4000, maxConsecutiveTimeouts: 2, maxTotalTimeouts: 6, reliableMode: false });
    } else {
      this._mcuMgr.configureTransport({ mtu: this._mtu, chunkTimeout: 5000, maxConsecutiveTimeouts: 2, maxTotalTimeouts: 6, reliableMode: false });
    }
  }

  async eraseSlot() {
    if (!this._mcuMgr) throw new Error('Manager not attached');
    await this._mcuMgr.cmdImageErase();
  }

  async readState() {
    const msg = await this._sendAndWait((done) => {
      this._mcuMgr.onMessage((m) => {
        if (m.op === 1 && m.group === 1 && m.id === 0) done(m.data);
      });
      this._mcuMgr.cmdImageState();
    }, 30000);

    if (msg.rc !== undefined && msg.rc !== 0) {
      throw new Error(SmpProvider._fmtRc(msg.rc, 'Image state read'));
    }

    const images = msg.images ?? [];
    return images.map((img) => ({
      slot:      img.slot,
      version:   fmtVersion(img.version),
      hash:      img.hash ? bufToHex(img.hash) : '',
      active:    !!img.active,
      pending:   !!img.pending,
      confirmed: !!img.confirmed,
    }));
  }

  async loadFirmware(file) {
    let data;
    if (typeof File !== 'undefined' && file instanceof File) {
      data = new Uint8Array(await file.arrayBuffer());
    } else if (file instanceof Uint8Array || file instanceof ArrayBuffer) {
      data = (file instanceof ArrayBuffer) ? new Uint8Array(file) : file;
    } else {
      throw new Error('loadFirmware expects File, Uint8Array, or ArrayBuffer');
    }

    const magic = new DataView(data.buffer, data.byteOffset).getUint32(0, true);
    if (magic !== 0x96f3b83d) throw new Error('Bad MCUboot magic — use zephyr.signed.bin');
    this._firmware = data;
    // Parse version from MCUboot header (offset 20: major, minor, revision)
    const view = new DataView(data.buffer, data.byteOffset);
    this._firmwareVersion = `${view.getUint8(20)}.${view.getUint8(21)}.${view.getUint16(22, true)}`;
  }

  get firmwareVersion() {
    return this._firmwareVersion;
  }

  async runUpdate() {
    if (!this._firmware || !this._mcuMgr) throw new Error('Firmware or manager not ready');

    this.emit('phase', { phase: 'upload', label: 'Uploading firmware…' });

    // Resume from last ack'd offset if we have one
    const startOffset = this._resumeOffset || 0;
    if (startOffset > 0) {
      this.emit('log', { message: `Resuming upload from offset ${startOffset}`, level: 'info' });
    }

    try {
      await this._doUpload(startOffset);
      this._resumeOffset = 0;  // Clear on success
    } catch (err) {
      // Save offset for potential resume
      this._resumeOffset = this._mcuMgr.uploadOffset;
      throw err;
    }

    this.emit('phase', { phase: 'test', label: 'Marking for test…' });
    const hash = await this._getUploadedHash();
    const data = await this._sendAndWait((done) => {
      this._mcuMgr.onMessage((msg) => {
        // Image test response: op=3 (WRITE_RSP), group=1, id=0
        if (msg.op === 3 && msg.group === 1 && msg.id === 0) done(msg.data);
      });
      this._mcuMgr.cmdImageTest(hash);
    });
    this.emit('phase', { phase: 'reset', label: 'Resetting device…' });
    this.emit('log', { message: 'Resetting device — will swap and boot new firmware…', level: 'info' });
    try { await this._mcuMgr.cmdReset(); } catch { /* timeout expected */ }

    this.emit('needs-reconnect', {});
    return { needsConfirm: true };
  }

  async confirm() {
    if (!this._mcuMgr) throw new Error('Manager not attached');
    const slots = await this.readState();
    const s0 = slots.find((s) => s.slot === 0);
    if (!s0 || !s0.active || s0.confirmed) {
      this.emit('log', { message: 'Slot 0 is not active or already confirmed — nothing to confirm.', level: 'warn' });
      return;
    }
    await this._sendAndWait((done) => {
      this._mcuMgr.onMessage((msg) => {
        if (msg.group === 1 && msg.id === 0) done(msg.data);
      });
      this._mcuMgr.cmdImageConfirm(s0.hash);
    }, 30000);

    this.emit('phase', { phase: 'confirm', label: 'Confirmed' });
  }

  // ── internal helpers ────────────────────────────────────────────────────────

  _doUpload(startOffset = 0) {
    return new Promise((resolve, reject) => {
      let lastPct = -1;
      this._mcuMgr.onImageUploadProgress((ev) => {
        const pct = ev.percentage ?? 0;
        const offset = Math.round(pct / 100 * this._firmware.byteLength);
        if (pct !== lastPct) {
          lastPct = pct;
          this.emit('progress', { phase: 'upload', currentBytes: offset, totalBytes: this._firmware.byteLength });
        }
      });
      this._mcuMgr.onImageUploadFinished(() => {
        this.emit('progress', { phase: 'upload', currentBytes: this._firmware.byteLength, totalBytes: this._firmware.byteLength });
        resolve();
      });
      this._mcuMgr.onImageUploadError((err) => reject(new Error(err.error)));
      this._mcuMgr.cmdUpload(this._firmware.buffer || this._firmware, 0, startOffset);
    });
  }

  async _getUploadedHash() {
    const slots = await this.readState();
    const slot1 = slots.find((s) => s.slot === 1);
    if (!slot1) throw new Error('Slot 1 not found after upload');
    return slot1.hash;
  }

  _sendAndWait(callback, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('SMP timeout')), timeoutMs);
      callback((value) => { clearTimeout(t); resolve(value); });
    });
  }
}
