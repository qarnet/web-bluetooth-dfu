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
    this._device      = null;   // BluetoothDevice ref for MAC-based reconnect
    this._connection  = null;
    this._provider    = null;
    this._firmware    = null;
    this._fileSig     = null;
    this._abortCtrl   = null;   // current operation abort controller
    this._nordicImageSelection = { base: false, app: true };
    this._continuationActive = false; // true after SD phase auto-reconnect; triggers crash retry
    this._nordicPrn = 0;
    this._awaitingReconnect = false;
    this._transferProfile = 'balanced';
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

    const payload = { name: file.name, size: data.byteLength, protocol: sig };

    // Extract firmware version from file
    if (sig === 'smp') {
      try {
        const view = new DataView(data.buffer, data.byteOffset);
        const major = view.getUint8(20);
        const minor = view.getUint8(21);
        const revision = view.getUint16(22, true);
        payload.version = `${major}.${minor}.${revision}`;
        const digest = await crypto.subtle.digest('SHA-256', data);
        const hash = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
        payload.preflight = `MCUboot magic OK, sha256=${hash.slice(0, 16)}…`;
      } catch {
        // Ignore version parse errors
      }
    }

    // For Nordic ZIPs, parse manifest metadata so the UI can show multi-image info
    if (sig === 'nordic') {
      try {
        const { NordicProvider } = await import('./nordic/nordic-provider.js');
        const analysis = await NordicProvider.analyzePackage(data);
        payload.nordicInfo = analysis;
        payload.preflight = `Nordic manifest: ${analysis.types.join(', ')}`;
      } catch (err) {
        this.emit('log', { message: `Failed to analyze Nordic package: ${err.message}`, level: 'warn' });
      }
    }

    this.emit('firmware-loaded', payload);
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
      this._device = connection.device;

      const deviceSig = detectFromDevice(connection.services);
      const proto = resolveProtocol(this._fileSig, deviceSig);

      const ProviderClass = PROVIDERS[proto];
      if (!ProviderClass) throw new Error(`Unknown protocol: ${proto}`);

      const provider = new ProviderClass({ mtu: 128 });
      provider.setImageSelection?.(this._nordicImageSelection);
      provider.setPrn?.(this._nordicPrn);
      provider.setTransferProfile?.(this._transferProfile);
      this._provider = provider;

      // Wire provider events straight through to the UI
      let attachComplete = false;
      provider.addEventListener('log',       (e) => this.emit('log',       e.detail));
      provider.addEventListener('progress',  (e) => this.emit('progress',  e.detail));
      provider.addEventListener('phase',     (e) => this.emit('phase',     e.detail));
      provider.addEventListener('needs-reconnect', (e) => {
        const detail = e.detail || {};
        this._awaitingReconnect = true;
        if (detail.continuationTimeout) {
          this._continuationActive = true;
        }
        this.emit('log', {
          message: `Provider requested reconnect (${JSON.stringify(detail) || 'no detail'})`,
          level: 'info',
        });
        this.emit('needs-reconnect', detail);
        if (attachComplete) {
          this._provider?.detach().catch(() => {});
        }
        this._connection = null;
        // Use a single reconnect owner (UI/manual reconnect) to avoid races
        // between auto-reconnect and explicit reconnect flows.
      });

      await provider.attach(connection);
      attachComplete = true;

      // needs-reconnect (buttonless path) clears _connection synchronously.
      // Do NOT emit 'connected' for the now-gone app-mode device.
      if (!this._connection) {
        this._setState(STATES.IDLE);
        return;
      }

      // If firmware was already loaded, push it into the new provider
      if (this._firmware) {
        try {
          await provider.loadFirmware(this._firmware.data);
        } catch (err) {
          this.emit('log', { message: err.message, level: 'error' });
        }
      }

      this._setState(STATES.CONNECTED);
      this._awaitingReconnect = false;
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
          // Emit current device version for the UI
          const activeSlot = slots.find((s) => s.active);
          if (activeSlot?.version) {
            this.emit('device-version', { version: activeSlot.version });
          }
        } catch (err) {
          this.emit('log', { message: err.message, level: 'error' });
        }
      }
    } catch (err) {
      this._setState(STATES.IDLE);
      this.emitRecoverableError(
        err.message,
        () => this.connect(filterConfig),
        'Retry'
      );
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

  async eraseSlot() {
    this._assertState(STATES.CONNECTED);
    if (!this._provider || !this._provider.eraseSlot) {
      throw new Error('Erase slot not supported by current protocol');
    }
    await this._provider.eraseSlot();
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

      if (!result?.needsContinue) {
        this._continuationActive = false;
      }
      this._setState(STATES.CONNECTED);
      if (!result?.needsConfirm && !result?.needsContinue) {
        this.emit('update-complete', {});
      }
    } catch (err) {
      if (this._continuationActive) {
        // Continuation app DFU crashed — likely CREATE_DATA blocked on 38-page erase of SD data,
        // exceeding BLE supervision timeout. The bootloader completes the erase anyway (blank-page
        // check means the next attempt skips it), stays in DFU via GPREGRET, and re-advertises.
        this._continuationActive = false;
        this.emit('log', {
          message: 'Continuation DFU crash (bank erase timeout) — reconnect and retry Update Firmware.',
          level: 'warn',
        });
        // Use explicit manual reconnect here. Auto-reconnect in this crash path can
        // race with late disconnect events from the failed transfer and leave the UI
        // in an indeterminate state.
        this._provider?.detach().catch(() => {});
        this._connection = null;
        this._setState(STATES.IDLE);
        this.emit('needs-reconnect', {});
        throw err;
      }
      this._setState(STATES.CONNECTED);
      throw err;
    } finally {
      this._abortCtrl = null;
    }
  }

  /** Cancel the currently-running upload (or confirm). */
  cancel() {
    this._abortCtrl?.abort('user-cancel');
    this._provider?.cancel();
  }

  setReliableMode(enabled) {
    this._provider?.setReliableMode(enabled);
  }

  setMultiImage(enabled) {
    // Backward-compatible toggle: enabled => base+app, disabled => app only.
    this.setNordicImageSelection({ base: !!enabled, app: true });
  }

  setNordicImageSelection(selection) {
    const next = {
      base: !!selection?.base,
      app: !!selection?.app,
    };
    this._nordicImageSelection = next;
    this._provider?.setImageSelection?.(next);
  }

  setNordicPrn(value) {
    this._nordicPrn = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
    this._provider?.setPrn?.(this._nordicPrn);
  }

  setTransferProfile(profile) {
    this._transferProfile = profile || 'balanced';
    this._provider?.setTransferProfile?.(this._transferProfile);
  }

  async smpEcho(text = 'ping') {
    this._assertState(STATES.CONNECTED);
    if (!this._provider?.echo) throw new Error('Echo is not supported by current protocol');
    return this._provider.echo(text);
  }

  async resetDevice() {
    this._assertState(STATES.CONNECTED);
    if (!this._provider?.deviceReset) throw new Error('Reset is not supported by current protocol');
    return this._provider.deviceReset();
  }

  async confirm() {
    this._assertState(STATES.CONNECTED);
    if (!this._provider) throw new Error('No provider attached');

    this._abortCtrl = new AbortController();
    this._setState(STATES.CONFIRMING);

    try {
      await this._provider.confirm();
      // Post-confirm slot read is skipped — it can hang on some firmware
      // versions and the user already saw the pre-confirm slot state.
      this.emit('update-complete', {});
    } finally {
      this._abortCtrl = null;
      this._setState(STATES.CONNECTED);
    }
  }

  // ── Reconnect helper (reuses connect, but UI knows it's a reconnect) ───────

  async reconnect(filterConfig) {
    this._awaitingReconnect = false;
    await this.connect(filterConfig);
  }

  // ── Error recovery helpers ────────────────────────────────────────────────

  emitRecoverableError(message, action = null, label = null) {
    this.emit('error', { message, recoverable: true, action, label });
  }

  emitError(message) {
    this.emit('error', { message, recoverable: false });
  }

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
