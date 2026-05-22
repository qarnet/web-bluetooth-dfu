import { Encoder } from '../vendor/cbor-x.js';

// SMP requires plain, standard CBOR. cbor-x defaults emit its non-standard
// "records" structure tag and encode Uint8Arrays as tagged typed arrays — the
// device's zcbor decoder rejects both. Force standard maps + plain byte strings.
const cbor = new Encoder({ useRecords: false, tagUint8Array: false });
const encode = (value) => cbor.encode(value);
const decode = (bytes) => cbor.decode(bytes);

// SMP header layout (8 bytes, big-endian):
//   Op(1) | Flags(1) | Length(2) | Group(2) | Seq(1) | Cmd(1)
const HEADER_SIZE = 8;

export const Op = { ReadReq: 0, ReadRsp: 1, WriteReq: 2, WriteRsp: 3 };
export const Group = { OS: 0, Image: 1 };
// mcumgr image-management command IDs (zephyr img_mgmt.h).
// State (0) serves both image list (read op) and test/confirm (write op).
export const ImageCmd = { State: 0, Upload: 1, Erase: 5 };
export const OsCmd = { Reset: 5 };

function buildFrame(op, group, seq, cmd, payload) {
  const encoded = encode(payload);
  const buf = new ArrayBuffer(HEADER_SIZE + encoded.byteLength);
  const view = new DataView(buf);
  view.setUint8(0, op);
  view.setUint8(1, 0);                               // flags
  view.setUint16(2, encoded.byteLength, false);      // big-endian length
  view.setUint16(4, group, false);                   // big-endian group
  view.setUint8(6, seq);
  view.setUint8(7, cmd);
  new Uint8Array(buf, HEADER_SIZE).set(encoded);
  return new Uint8Array(buf);
}

function parseFrame(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    op:      view.getUint8(0),
    flags:   view.getUint8(1),
    group:   view.getUint16(4, false),
    seq:     view.getUint8(6),
    cmd:     view.getUint8(7),
    payload: decode(data.slice(HEADER_SIZE)),
  };
}

/**
 * Manages SMP communication over a single BLE GATT characteristic.
 * Requests go out as Write Without Response; responses come in via notifications.
 * Queues writes to avoid "GATT operation in progress" errors.
 */
export class SmpClient {
  #seq = 0;
  #pending = new Map();   // seq → { resolve, reject }
  #queue = [];
  #queueBusy = false;

  constructor(characteristic) {
    this.characteristic = characteristic;
    characteristic.addEventListener(
      'characteristicvaluechanged',
      (e) => this.#onNotify(e),
    );
  }

  async start() {
    await this.characteristic.startNotifications();
  }

  async stop() {
    await this.characteristic.stopNotifications();
  }

  #onNotify(event) {
    const bytes = new Uint8Array(event.target.value.buffer);
    let frame;
    try {
      frame = parseFrame(bytes);
    } catch (err) {
      console.warn('[SMP] Failed to parse notification:', err, 'raw:', bytes);
      return;
    }
    console.debug(`[SMP] ← rx seq=${frame.seq} op=${frame.op} group=${frame.group} cmd=${frame.cmd}`, frame.payload);
    const pending = this.#pending.get(frame.seq);
    if (!pending) {
      console.warn(`[SMP] Unexpected response seq=${frame.seq} — no pending request`);
      return;
    }
    this.#pending.delete(frame.seq);
    pending.resolve(frame);
  }

  #enqueue(fn) {
    this.#queue.push(fn);
    if (!this.#queueBusy) this.#drain();
  }

  async #drain() {
    this.#queueBusy = true;
    while (this.#queue.length) {
      await this.#queue.shift()();
    }
    this.#queueBusy = false;
  }

  /**
   * Send an SMP request and wait for the matching response.
   * @param {number} op
   * @param {number} group
   * @param {number} cmd
   * @param {object} payload  – plain JS object, will be CBOR-encoded
   * @param {number} chunkSize – max bytes per BLE write (default 244)
   */
  send(op, group, cmd, payload, chunkSize = 244) {
    const seq = this.#seq++ & 0xff;
    const frame = buildFrame(op, group, seq, cmd, payload);

    console.debug(`[SMP] → tx seq=${seq} op=${op} group=${group} cmd=${cmd} total=${frame.byteLength}B chunks=${Math.ceil(frame.byteLength/chunkSize)}`, payload);

    return new Promise((resolve, reject) => {
      this.#pending.set(seq, { resolve, reject });

      for (let offset = 0; offset < frame.byteLength; offset += chunkSize) {
        const chunk = frame.slice(offset, offset + chunkSize);
        this.#enqueue(() => this.characteristic.writeValueWithoutResponse(chunk));
      }

      setTimeout(() => {
        if (this.#pending.has(seq)) {
          this.#pending.delete(seq);
          reject(new Error(`SMP timeout (seq=${seq})`));
        }
      }, 10_000);
    });
  }
}
