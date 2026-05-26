import { DfuProvider } from '../core/provider.js';
import { SecureDfu } from './secure-dfu.js';
import { SecureDfuPackage } from './package.js';
import { CRC32 } from '../vendor/crc32.js';
import JSZip from '../vendor/jszip.js';
import { REGISTRY } from '../core/registry.js';

export class NordicProvider extends DfuProvider {
  static get id()    { return 'nordic'; }
  static get label() { return 'Nordic Secure DFU'; }
  static get capabilities() {
    return {
      hasSlots: false,
      hasConfirmStep: false,
      hasTestStep: false,
      chunkConfigurable: false,
      multiObject: true,
      hasCancel: true,
    };
  }

  constructor() {
    super();
    this._dfu = new SecureDfu(CRC32);
    this._dfu.addEventListener('log',      (e) => this.emit('log',      e.detail));
    this._dfu.addEventListener('progress', (e) => this.emit('progress', e.detail));
    this._appImage = null;
    this._baseImage = null;
    this._baseTransferred = false;
    this._selection = { base: false, app: true };
    this._prn = 0;
  }

  /** Analyze a ZIP buffer without loading image data. */
  static async analyzePackage(buffer) {
    const pkg = new SecureDfuPackage(buffer);
    await pkg.load(JSZip);
    const info = pkg.getManifestInfo();
    return {
      ...info,
      // Pre-load the image objects so runUpdate can use them
      _rawBase: await pkg.getBaseImage(),
      _rawApp:  await pkg.getAppImage(),
    };
  }

  /** Toggle multi-image mode from UI checkbox. */
  setMultiImage(enabled) {
    this.setImageSelection({ base: !!enabled, app: true });
  }

  setImageSelection(selection) {
    this._selection = {
      base: !!selection?.base,
      app: !!selection?.app,
    };
  }

  async attach(session) {
    const nordicEntry = session.services.get(REGISTRY.nordic.serviceUuid);
    if (!nordicEntry) throw new Error('Nordic Secure DFU service not found');

    const chars = nordicEntry.characteristics;
    let device = session.device;

    // Check if we're in buttonless app mode (no control/packet, only buttonless)
    const hasControl = chars.has(REGISTRY.nordic.controlUuid);
    const hasPacket  = chars.has(REGISTRY.nordic.packetUuid);

    if (!hasControl || !hasPacket) {
      this.emit('log', { message: 'Device in app mode — triggering buttonless DFU…', level: 'info' });
      const withBonds = chars.has(REGISTRY.nordic.buttonlessWithBondsUuid);
      const needsReconnect = await this._dfu.triggerButtonless(device, withBonds, [...chars.values()]);
      if (needsReconnect) {
        this.emit('needs-reconnect', {});
        return;
      }
    }

    // Bootloader mode — connect via SecureDfu.connect, passing pre-resolved chars
    // (the Map values are already BleCharacteristic-wrapped by the connect layer)
    const allChars = [...chars.values()];
    await this._dfu.connect(device, allChars);
  }

  async detach() {
    this._dfu?.disposeConnection?.();
  }

  cancel() {
    this._dfu?.cancel();
  }

  setReliableMode(enabled) {
    this._dfu?.setReliableMode(enabled);
  }

  setPrn(value) {
    this._prn = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
    this._dfu?.setPacketReceiptNotifications(this._prn);
  }

  async readState() {
    return []; // Nordic Secure DFU does not expose image slots
  }

  async loadFirmware(file) {
    const buffer = (typeof File !== 'undefined' && file instanceof File)
      ? await file.arrayBuffer()
      : (file instanceof Uint8Array) ? file.buffer : file;

    const pkg = new SecureDfuPackage(buffer);
    await pkg.load(JSZip);

    this._baseImage = await pkg.getBaseImage();
    this._appImage  = await pkg.getAppImage();
    this._baseTransferred = false;

    if (!this._baseImage && !this._appImage) {
      throw new Error('No application or base image found in the ZIP package');
    }
  }

  async runUpdate() {
    if (!this._dfu) throw new Error('DFU engine not ready');

    const wantBase = this._selection.base && !!this._baseImage;
    const wantApp = this._selection.app && !!this._appImage;

    if (!wantBase && !wantApp) {
      throw new Error('No Nordic image selected for transfer');
    }

    // Step 1 — Base image (if selected and not already transferred)
    if (wantBase && !this._baseTransferred) {
      await this._transferImage(this._baseImage, 'Base firmware (SoftDevice/Bootloader)');
      this._baseTransferred = true;
      if (wantApp) {
        // Device will disconnect and reboot; bootloader stays in DFU mode
        // with continuation timeout (~10 s).
        this.emit('needs-reconnect', { continuationTimeout: 10000 });
        return { needsContinue: true };
      }
      this.emit('phase', { phase: 'execute', label: 'DFU complete' });
      this.emit('log', { message: 'Base firmware transfer complete. Device will reboot automatically.', level: 'ok' });
      return { needsConfirm: false, complete: true };
    }

    this._dfu.setPacketReceiptNotifications(this._prn);

    // Step 2 — Application image
    if (wantApp) {
      if (!this._dfu.isReady()) {
        this.emit('log', {
          message: 'DFU transport not ready after reconnect. Requesting reconnect before app transfer…',
          level: 'warn',
        });
        this.emit('needs-reconnect', { continuationTimeout: 10000 });
        return { needsContinue: true };
      }
      if (wantBase && this._baseTransferred) {
        const readiness = await this._dfu.probeReady();
        this.emit('log', {
          message: `Continuation ready: init max=${readiness.maxSize} offset=${readiness.offset} crc=0x${readiness.crc.toString(16)}`,
          level: 'info',
        });
      }
      try {
        await this._transferImage(this._appImage, 'Application');
      } catch (err) {
        const msg = String(err?.message || err || '');
        const disconnected =
          msg.includes('Device disconnected') ||
          msg.includes('GATT Server is disconnected') ||
          msg.includes('writeValueWithResponse') ||
          msg.includes('writeValueWithoutResponse');
        if (wantBase && this._baseTransferred && disconnected) {
          this.emit('log', {
            message: `Continuation link dropped before app transfer completed (${msg}). Reconnect and continue…`,
            level: 'warn',
          });
          this.emit('needs-reconnect', { continuationTimeout: 10000 });
          return { needsContinue: true };
        }
        throw err;
      }
      this.emit('phase', { phase: 'execute', label: 'DFU complete' });
      this.emit('log', { message: 'DFU complete. Device will reboot automatically.', level: 'ok' });
      return { needsConfirm: false, complete: true };
    }

    throw new Error('Selected Nordic image is missing in this package');
  }

  async _transferImage(image, label) {
    const initLen = image?.initData?.byteLength ?? image?.initData?.length ?? 0;
    const fwLen = image?.imageData?.byteLength ?? image?.imageData?.length ?? 0;
    const initHash = await this._sha256Hex(image?.initData);
    const fwHash = await this._sha256Hex(image?.imageData);
    this.emit('log', {
      message: `[TRACE] ${label}: init_len=${initLen} init_sha256=${initHash} fw_len=${fwLen} fw_sha256=${fwHash}`,
      level: 'info',
    });

    this.emit('phase', { phase: 'transfer', label: `Transferring init packet (${label})…` });
    await this._dfu.transferInit(image.initData);

    this.emit('phase', { phase: 'transfer', label: `Transferring firmware (${label})…` });
    await this._dfu.transferFirmware(image.imageData);
  }

  async _sha256Hex(data) {
    if (!data) return 'none';
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (!globalThis.crypto?.subtle) return 'sha256-unavailable';
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async confirm() {
    // Nordic does not have an explicit confirm step
  }
}
