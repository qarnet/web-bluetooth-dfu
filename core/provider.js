import { DfuEventTarget } from './events.js';

/**
 * Base class for a DFU protocol provider.
 * Each provider owns one DFU session created after BLE connection exists.
 */
export class DfuProvider extends DfuEventTarget {
  static get id()      { throw new Error('id not implemented'); }
  static get label()   { throw new Error('label not implemented'); }
  static get capabilities() {
    return {
      hasSlots: false,
      hasConfirmStep: false,
      hasTestStep: false,
      chunkConfigurable: false,
      multiObject: false,
    };
  }

  /** @param {object} session — result from bluetooth/connect.js */
  async attach(session) { throw new Error('attach not implemented'); }

  /** @returns {Promise<Array<SlotDescriptor>>} */
  async readState() { return []; }

  /** @param {File|Uint8Array} file — validate and parse */
  async loadFirmware(file) { throw new Error('loadFirmware not implemented'); }

  /** Run the full update. Emits 'log', 'progress', 'phase', 'needs-reconnect'. */
  async runUpdate() { throw new Error('runUpdate not implemented'); }

  /** SMP only: finalize pending swap after reconnect. */
  async confirm() { /* no-op by default */ }

  /** Stop notifications, drop listeners (does NOT disconnect GATT). */
  async detach() { /* no-op by default */ }
}
