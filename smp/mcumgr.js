import { encode as CBOREncode, decode as CBORDecode } from './cbor.js';

const MGMT_OP_READ      = 0;
const MGMT_OP_READ_RSP  = 1;
const MGMT_OP_WRITE     = 2;
const MGMT_OP_WRITE_RSP = 3;

const MGMT_GROUP_ID_OS    = 0;
const MGMT_GROUP_ID_IMAGE = 1;

const OS_MGMT_ID_RESET = 5;

const IMG_MGMT_ID_STATE  = 0;
const IMG_MGMT_ID_UPLOAD = 1;
const IMG_MGMT_ID_ERASE  = 5;

const NMP_HEADER_SIZE = 8;

/** MCUManager — SMP protocol engine, transport-decoupled. */
export class MCUManager {
  /**
   * @param {object} opts
   * @param {BluetoothRemoteGATTCharacteristic} opts.characteristic — already-connected SMP char
   * @param {object} [opts.logger]
   * @param {number} [opts.mtu=400] — max bytes per BLE write frame
   * @param {number} [opts.chunkTimeout=5000] — ms before retrying a chunk
   * @param {number} [opts.maxConsecutiveTimeouts=2]
   * @param {number} [opts.maxTotalTimeouts=6]
   */
  constructor(opts = {}) {
    this._characteristic = opts.characteristic;
    this._mtu = opts.mtu || 244;
    this._minMtu = opts.minMtu || 20;
    this._logger = opts.logger || { info: console.log, error: console.error };
    this._reliableMode = opts.reliableMode || false;

    this._chunkTimeout   = opts.chunkTimeout || 5000;
    this._maxConsecutiveTimeouts = opts.maxConsecutiveTimeouts || 2;
    this._maxTotalTimeouts       = opts.maxTotalTimeouts || 6;

    this._seq = 0;
    this._buffer = new Uint8Array();
    this._uploadIsInProgress = false;

    // Notification handler binding
    this._boundNotification = this._notification.bind(this);
    this._characteristic.addEventListener('characteristicvaluechanged', this._boundNotification);

    // Start notifications if not already started
    if (!this._characteristic.startNotifications) {
      throw new Error('Characteristic must support startNotifications');
    }
  }

  /** Must be called after construction so the adapter can await it. */
  async start() {
    await this._characteristic.startNotifications();
  }

  async stop() {
    try {
      await this._characteristic.stopNotifications();
    } catch (e) { /* ignore */ }
    this._characteristic.removeEventListener('characteristicvaluechanged', this._boundNotification);
  }

  // ── Low-level SMP framing ──────────────────────────────────────────────────

  static _encode(object) {
    return new Uint8Array(CBOREncode(object));
  }

  static _decode(data) {
    return CBORDecode(data);
  }

  _buildFrame(op, group, id, data) {
    const encoded = (data === undefined) ? new Uint8Array()
      : MCUManager._encode(data);
    const lengthLo = encoded.length & 0xff;
    const lengthHi = encoded.length >> 8;
    const groupLo = group & 0xff;
    const groupHi = group >> 8;
    const seq = this._seq;
    const header = new Uint8Array([
      op, 0, lengthHi, lengthLo, groupHi, groupLo, seq, id,
    ]);
    const frame = new Uint8Array(header.length + encoded.length);
    frame.set(header, 0);
    frame.set(encoded, header.length);
    return { frame, seq };
  }

  async _sendMessage(op, group, id, data) {
    const { frame } = this._buildFrame(op, group, id, data);
    await this._writeFragmented(frame);
    this._seq = (this._seq + 1) % 256;
  }

  setReliableMode(enabled) {
    this._reliableMode = !!enabled;
    this._logger.info(`Reliable mode ${this._reliableMode ? 'enabled' : 'disabled'}`);
  }

  async _writeFragmented(frame) {
    for (let offset = 0; offset < frame.byteLength; offset += this._mtu) {
      const chunk = frame.slice(offset, offset + this._mtu);
      if (this._reliableMode) {
        await this._characteristic.writeValueWithResponse(chunk);
      } else {
        await this._characteristic.writeValueWithoutResponse(chunk);
      }
    }
  }

  // ── Notification assembly ────────────────────────────────────────────────

  _notification(event) {
    const message = new Uint8Array(event.target.value.buffer);
    this._buffer = new Uint8Array([...this._buffer, ...message]);
    while (this._buffer.length >= NMP_HEADER_SIZE) {
      const length = this._buffer[2] * 256 + this._buffer[3];
      const fullLength = NMP_HEADER_SIZE + length;
      if (this._buffer.length < fullLength) return;
      const frame = this._buffer.slice(0, fullLength);
      this._buffer = this._buffer.slice(fullLength);
      this._processMessage(frame);
    }
  }

  _processMessage(message) {
    const op = message[0];
    const length = message[2] * 256 + message[3];
    const group = message[4] * 256 + message[5];
    const seq = message[6];
    const id = message[7];
    const payloadBuffer = message.buffer.slice(
      message.byteOffset + NMP_HEADER_SIZE,
      message.byteOffset + message.byteLength,
    );
    const data = length ? MCUManager._decode(payloadBuffer) : null;

    this._logger.info('[MCUManager] rx', { op, group, id, seq, length, dataKeys: data ? Object.keys(data) : null });

    if (group === MGMT_GROUP_ID_IMAGE && id === IMG_MGMT_ID_UPLOAD) {
      if (this._uploadTimeout) {
        clearTimeout(this._uploadTimeout);
        this._uploadTimeout = null;
      }

      if (data && data.rc !== undefined && data.rc !== 0) {
        this._uploadIsInProgress = false;
        const errorMessages = {
          1: 'Unknown error',
          2: 'Slot is busy or in bad state. Try erasing the slot first or confirming/testing pending images.',
          3: 'Invalid value',
          4: 'Operation timeout',
          5: 'No entry found',
          6: 'Bad state',
          7: 'Response too large',
          8: 'Not supported',
          9: 'Data is corrupt',
          10: 'Device is busy'
        };
        const errorMsg = errorMessages[data.rc] || `Device returned error code ${data.rc}`;
        this._logger.error(`Upload failed: ${errorMsg}`);
        if (this._imageUploadErrorCallback) {
          this._imageUploadErrorCallback({
            error: `Upload failed: ${errorMsg}`,
            errorCode: data.rc,
            consecutiveTimeouts: this._consecutiveTimeouts,
            totalTimeouts: this._totalTimeouts
          });
        }
        return;
      }

      if ((data.rc === 0 || data.rc === undefined) && data.off !== undefined) {
        this._consecutiveTimeouts = 0;
        this._uploadOffset = data.off;
        this._lastAckOffset = data.off;  // Track for resume
        this._uploadNext();
        return;
      }
    }

    if (this._messageCallback) {
      this._messageCallback({ op, group, id, data, length });
    }
  }

  // ── Callback hooks ─────────────────────────────────────────────────────────

  onMessage(callback)          { this._messageCallback = callback; return this; }
  onImageUploadProgress(callback) { this._imageUploadProgressCallback = callback; return this; }
  onImageUploadFinished(callback) { this._imageUploadFinishedCallback = callback; return this; }
  onImageUploadError(callback)    { this._imageUploadErrorCallback = callback; return this; }
  onImageUploadCancelled(callback){ this._imageUploadCancelledCallback = callback; return this; }

  // ── High-level commands ────────────────────────────────────────────────────

  cmdReset() { return this._sendMessage(MGMT_OP_WRITE, MGMT_GROUP_ID_OS, OS_MGMT_ID_RESET); }
  cmdImageState() { return this._sendMessage(MGMT_OP_READ,  MGMT_GROUP_ID_IMAGE, IMG_MGMT_ID_STATE); }
  cmdImageErase() { return this._sendMessage(MGMT_OP_WRITE, MGMT_GROUP_ID_IMAGE, IMG_MGMT_ID_ERASE, {}); }
  cmdImageTest(hash) {
    return this._sendMessage(MGMT_OP_WRITE, MGMT_GROUP_ID_IMAGE, IMG_MGMT_ID_STATE,
      { hash: hexToBuf(hash), confirm: false });
  }
  cmdImageConfirm(hash) {
    return this._sendMessage(MGMT_OP_WRITE, MGMT_GROUP_ID_IMAGE, IMG_MGMT_ID_STATE,
      { hash: hexToBuf(hash), confirm: true });
  }

  // ── Upload ─────────────────────────────────────────────────────────────────

  async _hash(image) {
    const digest = await crypto.subtle.digest('SHA-256', image);
    return new Uint8Array(digest);
  }

  async _uploadNext() {
    if (this._uploadOffset >= this._uploadImage.byteLength) {
      this._uploadIsInProgress = false;
      if (this._uploadTimeout) { clearTimeout(this._uploadTimeout); this._uploadTimeout = null; }
      if (this._imageUploadFinishedCallback) this._imageUploadFinishedCallback();
      return;
    }

    if (this._uploadTimeout) clearTimeout(this._uploadTimeout);
    this._uploadTimeout = setTimeout(() => {
      this._consecutiveTimeouts++;
      this._totalTimeouts++;
      this._logger.info(`Upload chunk timeout (consecutive: ${this._consecutiveTimeouts}, total: ${this._totalTimeouts})`);

      if (this._totalTimeouts >= this._maxTotalTimeouts) {
        this._uploadIsInProgress = false;
        const error = `Upload failed: Device not responding after ${this._totalTimeouts} attempts.`;
        this._logger.error(error);
        if (this._imageUploadErrorCallback) {
          this._imageUploadErrorCallback({ error, consecutiveTimeouts: this._consecutiveTimeouts, totalTimeouts: this._totalTimeouts });
        }
        return;
      }

      if (this._consecutiveTimeouts >= this._maxConsecutiveTimeouts) {
        this._chunkTimeout = Math.min(this._chunkTimeout * 2, 15000);
        const oldMtu = this._mtu;
        this._mtu = Math.max(Math.floor(this._mtu / 2), this._minMtu);
        this._logger.info(
          `Timeout #${this._consecutiveTimeouts}: halving MTU ${oldMtu} → ${this._mtu} and increasing chunk timeout to ${this._chunkTimeout}ms`
        );
        this._logger.info(
          `If upload continues to stall, try reducing chunk size manually or reconnect.`
        );
        if (this._imageUploadProgressCallback) {
          this._imageUploadProgressCallback({
            percentage: Math.floor(this._uploadOffset / this._uploadImage.byteLength * 100),
            timeoutAdjusted: true,
            newTimeout: this._chunkTimeout,
            newMtu: this._mtu,
          });
        }
      }

      this._uploadNext();
    }, this._chunkTimeout);

    const nmpOverhead = 8;
    const message = { data: new Uint8Array(), off: this._uploadOffset };
    if (this._uploadOffset === 0) {
      message.len = this._uploadImage.byteLength;
      message.sha = await this._hash(this._uploadImage);
    }

    if (this._imageUploadProgressCallback) {
      this._imageUploadProgressCallback({
        percentage: Math.floor(this._uploadOffset / this._uploadImage.byteLength * 100)
      });
    }

    const encoded = MCUManager._encode(message);
    const length = this._mtu - encoded.byteLength - nmpOverhead;
    message.data = new Uint8Array(this._uploadImage.slice(this._uploadOffset, this._uploadOffset + length));

    await this._sendMessage(MGMT_OP_WRITE, MGMT_GROUP_ID_IMAGE, IMG_MGMT_ID_UPLOAD, message);
  }

  async cmdUpload(image, slot = 0, startOffset = 0) {
    if (this._uploadIsInProgress) {
      this._logger.error('Upload is already in progress.');
      return;
    }
    this._uploadIsInProgress = true;
    this._uploadOffset = startOffset;
    this._uploadImage = image;
    this._uploadSlot = slot;
    this._consecutiveTimeouts = 0;
    this._totalTimeouts = 0;
    this._chunkTimeout = 5000;
    this._uploadNext();
  }

  get uploadOffset() {
    return this._lastAckOffset || this._uploadOffset || 0;
  }

  cancelUpload() {
    if (!this._uploadIsInProgress) return;
    if (this._uploadTimeout) { clearTimeout(this._uploadTimeout); this._uploadTimeout = null; }
    this._uploadIsInProgress = false;
    // Preserve _uploadOffset for potential resume; don't reset to 0
    this._uploadImage = null;
    this._consecutiveTimeouts = 0;
    this._totalTimeouts = 0;
    this._logger.info('Upload cancelled by user');
    if (this._imageUploadCancelledCallback) this._imageUploadCancelledCallback();
  }

  // ── Image info / metadata ───────────────────────────────────────────────────

  *_extractTlvs(data) {
    const view = new DataView(data);
    let offset = 0;
    while (offset < view.byteLength) {
      const tag = view.getUint16(offset, true);
      const len = view.getUint16(offset + 2, true);
      offset += 4;
      const valueData = view.buffer.slice(offset, offset + len);
      offset += len;
      yield { tag, value: new Uint8Array(valueData) };
    }
  }

  /** @param {ArrayBuffer} image */
  async imageInfo(image) {
    const info = {};
    info.tags = {};
    const view = new DataView(image);

    if (view.byteLength < 32) throw new Error('Invalid image (too short file)');
    if (view.getUint32(0, true) !== 0x96f3b83d) throw new Error('Invalid image (wrong magic bytes)');
    if (view.getUint32(4, true) !== 0) throw new Error('Invalid image (wrong load address)');

    const headerSize = view.getUint16(8, true);
    const protected_tlv_length = view.getUint16(10, true);
    const imageSize = view.getUint32(12, true);
    info.imageSize = imageSize;

    if (view.byteLength < imageSize + headerSize) throw new Error('Invalid image (wrong image size)');
    if (view.getUint32(16, true) !== 0x00) throw new Error('Invalid image (wrong flags)');

    const version = `${view.getUint8(20)}.${view.getUint8(21)}.${view.getUint16(22, true)}`;
    info.version = version;

    const totalHashLen = imageSize + headerSize + protected_tlv_length;
    const hashBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', image.slice(0, totalHashLen)));
    info.hash = [...hashBytes].map(b => b.toString(16).padStart(2, '0')).join('');

    let offset = headerSize + imageSize;
    let tlv_end = offset;

    if (protected_tlv_length > 0) {
      if (view.getUint16(offset, true) !== 0x6908) {
        throw new Error(`Expected protected TLV magic number. (0x${offset.toString(16)}: 0x${view.getUint16(offset, true).toString(16)})`);
      }
      tlv_end = view.getUint16(offset + 2, true) + offset;
      for (const tlv of this._extractTlvs(view.buffer.slice(offset + 4, tlv_end))) {
        info.tags[tlv.tag] = tlv.value;
      }
      offset = tlv_end;
    }

    if (view.getUint16(offset, true) !== 0x6907) {
      throw new Error(`Expected TLV magic number. (0x${offset.toString(16)}: 0x${view.getUint16(offset, true).toString(16)})`);
    }
    tlv_end = view.getUint16(offset + 2, true) + offset;
    for (const tlv of this._extractTlvs(view.buffer.slice(offset + 4, tlv_end))) {
      info.tags[tlv.tag] = tlv.value;
    }

    if (16 in info.tags && info.tags[16].length === hashBytes.length) {
      info.hashValid = info.tags[16].every((b, i) => b === hashBytes[i]);
    }

    return info;
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function hexToBuf(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return out;
}
