import { connectToDevice } from './bluetooth/connect.js';
import { SmpProvider } from './smp/smp-provider.js';
import { NordicProvider } from './nordic/nordic-provider.js';
import { detectFromFile, detectFromDevice, resolveProtocol } from './core/detect.js';

const PROVIDERS = {
  smp: SmpProvider,
  nordic: NordicProvider,
};

/** Valid state machine states. */
const STATES = {
  IDLE:         'idle',
  CONNECTING:   'connecting',
  CONNECTED:    'connected',
  UPLOADING:    'uploading',
  CONFIRMING:   'confirming',
  DISCONNECTING:'disconnecting',
};

/**
 * AppController — singleton orchestrator for the DFU flow.
 *
 * Bridges the UI (app.js) with the BLE transport and protocol providers.
 * Owns the single source of truth for:
 *   - connection  { device, server, services, disconnect }
 *   - provider    DfuProvider instance (after attach)
 *   - firmware    { data, file } (after file selection)
 *   - fileSig     'smp' | 'nordic' | null
 */
export class AppController extends EventTarget {
  constructor() {
    super();
    this._state       = STATES.IDLE;
    this._connection  = null;
    this._provider    = null;
    this._firmware    = null;
    this._fileSig     = null;
    this._abortCtrl   = null;   // current operation abort controller
  }

  // ── Public accessors (read-only for UI) ────────────────────────────────────

  get state()       { return this._state; }
  get isConnected() { return !!this._connection; }
  get hasProvider() { return !!this._provider; }
  get hasFirmware() { return !!this._firmware; }
  get firmwareData() { return this._firmware?.data ?? null; }
  get providerCapabilities() { return this._provider?.constructor.capabilities ?? {}; }

  _setState(newState) {
    if (this._state === newState) return;
    const oldState = this._state;
    this._state = newState;
    this.emit('state-changed', { state: newState, previous: oldState });
  }

  _assertState(...allowed) {
    if (!allowed.includes(this._state)) {
      throw new Error(`Invalid operation in state "${this._state}" (expected one of: ${allowed.join(', ')})`);
    }
  }

  // ── Firmware loading (called by UI file picker) ────────────────────────────

  async loadFirmware(file) {
    const data = new Uint8Array(await file.arrayBuffer());
    const sig  = detectFromFile(data);

    this._firmware = { data, file };
    this._fileSig  = sig;

    this.emit('firmware-loaded', { name: file.name, size: data.byteLength, protocol: sig });
    return sig;
  }

  unloadFirmware() {
    this._firmware = null;
    this._fileSig  = null;
    this.emit('firmware-unloaded', {});
  }

  // ── Connection lifecycle ──────────────────────────────────────────────────

  async connect(filterConfig) {
    // Allow connect from idle (first connect) or connected (reconnect after needs-reconnect)
    if (![STATES.IDLE, STATES.CONNECTED].includes(this._state)) {
      throw new Error(`Cannot connect in state "${this._state}"`);
    }

    this._setState(STATES.CONNECTING);
    const onDisconnect = () => this._handleDisconnect('device');

    try {
      const connection = await connectToDevice(filterConfig, onDisconnect);
      this._connection = connection;

      const deviceSig = detectFromDevice(connection.services);
      const proto = resolveProtocol(this._fileSig, deviceSig);

      const ProviderClass = PROVIDERS[proto];
      if (!ProviderClass) throw new Error(`Unknown protocol: ${proto}`);

      const provider = new ProviderClass({ mtu: 128 });
      this._provider = provider;

      // Wire provider events straight through to the UI
      let attachComplete = false;
      provider.addEventListener('log',       (e) => this.emit('log',       e.detail));
      provider.addEventListener('progress',  (e) => this.emit('progress',  e.detail));
      provider.addEventListener('phase',     (e) => this.emit('phase',     e.detail));
      provider.addEventListener('needs-reconnect', () => {
        this.emit('needs-reconnect', {});
        // Only detach if attach() has already finished (SMP runUpdate path).
        // If needs-reconnect fires DURING attach() (Nordic buttonless path),
        // the same provider instance will be reused after reconnect, so we
        // must keep it alive.
        if (attachComplete) {
          this._provider?.detach().catch(() => {});
        }
        this._connection = null;
      });

      await provider.attach(connection);
      attachComplete = true;

      // If firmware was already loaded, push it into the new provider
      if (this._firmware) {
        try {
          await provider.loadFirmware(this._firmware.data);
        } catch (err) {
          this.emit('log', { message: err.message, level: 'error' });
        }
      }

      this._setState(STATES.CONNECTED);
      this.emit('connected', {
        deviceName: connection.device.name ?? 'Unknown',
        protocol: proto,
        capabilities: ProviderClass.capabilities,
      });

      // Immediately fetch slot state if supported
      if (ProviderClass.capabilities.hasSlots) {
        try {
          const slots = await provider.readState();
          this.emit('slots-updated', { slots });
        } catch (err) {
          this.emit('log', { message: err.message, level: 'error' });
        }
      }
    } catch (err) {
      this._setState(STATES.IDLE);
      throw err;
    }
  }

  disconnect() {
    if (![STATES.CONNECTED, STATES.UPLOADING, STATES.CONFIRMING, STATES.CONNECTING].includes(this._state)) {
      // Nothing to do if already idle or disconnecting
      return;
    }
    this._setState(STATES.DISCONNECTING);

    // Cancel any in-flight operation
    this._abortCtrl?.abort('user-disconnect');

    this._connection?.disconnect();
    this._connection = null;
    this._provider?.detach().catch(() => {});
    this._provider = null;
    this._abortCtrl = null;

    this._setState(STATES.IDLE);
    this.emit('disconnected', { reason: 'user' });
  }

  async refreshSlots() {
    this._assertState(STATES.CONNECTED);
    if (!this._provider) return;
    const slots = await this._provider.readState();
    this.emit('slots-updated', { slots });
  }

  // ── DFU ───────────────────────────────────────────────────────────────────

  async runUpdate() {
    this._assertState(STATES.CONNECTED);
    if (!this._provider || !this._firmware) {
      throw new Error('Provider or firmware not ready');
    }

    this._abortCtrl = new AbortController();
    this._setState(STATES.UPLOADING);

    try {
      // Provider may need firmware loaded (e.g. after reconnect)
      await this._provider.loadFirmware(this._firmware.data);
      const result = await this._provider.runUpdate();

      this._setState(STATES.CONNECTED);
      if (!result?.needsConfirm) {
        this.emit('update-complete', {});
      }
    } catch (err) {
      this._setState(STATES.CONNECTED);
      throw err;
    } finally {
      this._abortCtrl = null;
    }
  }

  /** Cancel the currently-running upload (or confirm). */
  cancel() {
    this._abortCtrl?.abort('user-cancel');
  }

  async confirm() {
    this._assertState(STATES.CONNECTED);
    if (!this._provider) throw new Error('No provider attached');

    this._abortCtrl = new AbortController();
    this._setState(STATES.CONFIRMING);

    try {
      await this._provider.confirm();
      const slots = await this._provider.readState();
      this.emit('slots-updated', { slots });
    } finally {
      this._abortCtrl = null;
      this._setState(STATES.CONNECTED);
    }
  }

  // ── Reconnect helper (reuses connect, but UI knows it's a reconnect) ───────

  async reconnect(filterConfig) {
    await this.connect(filterConfig);
  }

  // ── internal ──────────────────────────────────────────────────────────────

  _handleDisconnect(reason) {
    this._connection = null;
    this._setState(STATES.IDLE);
    this.emit('disconnected', { reason });
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

// Singleton instance
export const controller = new AppController();
