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
    };
  }

  constructor() {
    super();
    this._dfu = null;
    this._package = null;
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

  async readState() {
    return []; // Nordic Secure DFU does not expose image slots
  }

  async loadFirmware(file) {
    const buffer = (typeof File !== 'undefined' && file instanceof File)
      ? await file.arrayBuffer()
      : (file instanceof Uint8Array) ? file.buffer : file;

    const pkg = new SecureDfuPackage(buffer);
    await pkg.load(JSZip);

    // Prefer application first, then base images
    let image = await pkg.getAppImage();
    if (!image) image = await pkg.getBaseImage();
    if (!image) throw new Error('No application or base image found in the ZIP package');

    this._package = image;
  }

  async runUpdate() {
    if (!this._package || !this._dfu) throw new Error('Package or DFU engine not ready');

    this.emit('phase', { phase: 'transfer', label: 'Transferring init packet…' });
    await this._dfu.transferInit(this._package.initData);

    this.emit('phase', { phase: 'transfer', label: 'Transferring firmware…' });
    await this._dfu.transferFirmware(this._package.imageData);

    this.emit('phase', { phase: 'execute', label: 'DFU complete' });
    this.emit('log', { message: 'DFU complete. Device will reboot automatically.', level: 'ok' });
    return { needsConfirm: false };
  }

  async confirm() {
    // Nordic does not have an explicit confirm step
  }
}
