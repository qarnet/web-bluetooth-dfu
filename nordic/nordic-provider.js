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
    this._dfu = null;
    this._appImage = null;
    this._baseImage = null;
    this._baseTransferred = false;
    this._multiImageEnabled = false;
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
    this._multiImageEnabled = enabled;
  }

  async attach(session) {
    const nordicEntry = session.services.get(REGISTRY.nordic.serviceUuid);
    if (!nordicEntry) throw new Error('Nordic Secure DFU service not found');

    const chars = nordicEntry.characteristics;
    let device = session.device;

    // Check if we're in buttonless app mode (no control/packet, only buttonless)
    const hasControl = chars.has(REGISTRY.nordic.controlUuid);
    const hasPacket  = chars.has(REGISTRY.nordic.packetUuid);

    this._dfu = new SecureDfu(CRC32);
    this._dfu.addEventListener('log', (e) => this.emit('log', e.detail));
    this._dfu.addEventListener('progress', (e) => this.emit('progress', e.detail));

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
    this._dfu = null;
  }

  cancel() {
    this._dfu?.cancel();
  }

  setReliableMode(enabled) {
    this._dfu?.setReliableMode(enabled);
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

    // Step 1 — Base image (only when multi-image mode enabled)
    if (this._multiImageEnabled && this._baseImage && !this._baseTransferred) {
      await this._transferImage(this._baseImage, 'Base firmware (SoftDevice/Bootloader)');
      this._baseTransferred = true;
      // Device will disconnect and reboot; bootloader stays in DFU mode
      // with continuation timeout (~10 s).
      this.emit('needs-reconnect', { continuationTimeout: 10000 });
      return { needsContinue: true };
    }

    // Step 2 — Application image
    if (this._appImage) {
      await this._transferImage(this._appImage, 'Application');
      this.emit('phase', { phase: 'execute', label: 'DFU complete' });
      this.emit('log', { message: 'DFU complete. Device will reboot automatically.', level: 'ok' });
      return { needsConfirm: false, complete: true };
    }

    // Edge case: only a base image and not in multi-image mode
    if (this._baseImage) {
      await this._transferImage(this._baseImage, 'Base firmware');
      this.emit('phase', { phase: 'execute', label: 'DFU complete' });
      this.emit('log', { message: 'DFU complete. Device will reboot automatically.', level: 'ok' });
      return { needsConfirm: false, complete: true };
    }

    throw new Error('No image selected for transfer');
  }

  async _transferImage(image, label) {
    this.emit('phase', { phase: 'transfer', label: `Transferring init packet (${label})…` });
    await this._dfu.transferInit(image.initData);

    this.emit('phase', { phase: 'transfer', label: `Transferring firmware (${label})…` });
    await this._dfu.transferFirmware(image.imageData);
  }

  async confirm() {
    // Nordic does not have an explicit confirm step
  }
}
