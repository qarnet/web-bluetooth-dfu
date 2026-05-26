/** Ported from web-bluetooth-dfu secure-dfu.ts to vanilla JS (ES module).
 *  Vanilla JS — no TypeScript, no external deps except core/events.js and vendor/crc32.js.
 */

import { DfuEventTarget } from '../core/events.js';

const CONTROL_UUID = "8ec90001-f315-4f60-9fb8-838830daea50";
const PACKET_UUID  = "8ec90002-f315-4f60-9fb8-838830daea50";
const BUTTON_UUID  = "8ec90003-f315-4f60-9fb8-838830daea50";
const BUTTON_BONDS_UUID = "8ec90004-f315-4f60-9fb8-838830daea50";

const LITTLE_ENDIAN = true;
const PACKET_SIZE = 20;   // Web Bluetooth cannot query MTU — safe floor

const OPERATIONS = {
  BUTTON_COMMAND:         [ 0x01 ],
  CREATE_COMMAND:         [ 0x01, 0x01 ],
  CREATE_DATA:            [ 0x01, 0x02 ],
  RECEIPT_NOTIFICATIONS:  [ 0x02 ],
  CACULATE_CHECKSUM:      [ 0x03 ],
  EXECUTE:                [ 0x04 ],
  SELECT_COMMAND:         [ 0x06, 0x01 ],
  SELECT_DATA:            [ 0x06, 0x02 ],
  RESPONSE:               [ 0x60, 0x20 ]
};

const RESPONSE = {
  0x00: "Invalid opcode",
  0x01: "Operation successful",
  0x02: "Opcode not supported",
  0x03: "Missing or invalid parameter value",
  0x04: "Not enough memory for the data object",
  0x05: "Data object does not match the firmware and hardware requirements",
  0x07: "Not a valid object type for a Create request",
  0x08: "The state of the DFU process does not allow this operation",
  0x0A: "Operation failed",
  0x0B: "Extended error"
};

const EXTENDED_ERROR = {
  0x00: "No extended error code has been set",
  0x01: "Invalid error code",
  0x02: "The format of the command was incorrect",
  0x03: "The command was successfully parsed, but it is not supported",
  0x04: "The init command is invalid",
  0x05: "The firmware version is too low",
  0x06: "The hardware version of the device does not match",
  0x07: "The array of supported SoftDevices for the update does not contain the FWID",
  0x08: "The init packet does not contain a signature",
  0x09: "The hash type that is specified by the init packet is not supported",
  0x0A: "The hash of the firmware image cannot be calculated",
  0x0B: "The type of the signature is unknown or not supported",
  0x0C: "The hash of the received firmware image does not match the hash in the init packet",
  0x0D: "The available space on the device is insufficient to hold the firmware"
};

/** Cross-platform helper: Web Bluetooth uses addEventListener; node-ble uses .on('disconnect') */
function _onDeviceDisconnect(device, handler) {
  if (typeof device.addEventListener === 'function') {
    device.addEventListener('gattserverdisconnected', handler);
    return () => device.removeEventListener('gattserverdisconnected', handler);
  }
  device.on('disconnect', handler);
  return () => device.off('disconnect', handler);
}

function _onNotify(char, handler) {
  if (typeof char.addEventListener === 'function') {
    char.addEventListener('characteristicvaluechanged', handler);
    return () => char.removeEventListener('characteristicvaluechanged', handler);
  }
  char.on('valuechanged', handler);
  return () => char.off('valuechanged', handler);
}

export class SecureDfu extends DfuEventTarget {
  static SERVICE_UUID = 0xFE59;

  constructor(crc32, delay = 0) {
    super();
    this._crc32 = crc32;
    this._delay = delay;
    this._notifyFns = {};
    this._controlChar = null;
    this._packetChar = null;
    this._notifyCleanupFn = null;
    this._disconnectCleanupFn = null;
    this._abortRequested = false;
    this._reliableMode = false;
  }

  log(message) {
    this.emit('log', { message, level: 'info' });
  }

  progress(bytes, totalBytes, object) {
    this.emit('progress', { object: object || 'unknown', totalBytes: totalBytes || 0, currentBytes: bytes });
  }

  /** Connect to an already-paired device, resolve characteristics, start notifications.
   *  If `characteristics` is provided (e.g. from BleCharacteristic wrappers), use them
   *  directly instead of re-discovering via getCharacteristics().
   */
  async connect(device, characteristics = null) {
    // Remove stale listeners from prior connect to prevent late-firing from old device nulling chars
    if (this._disconnectCleanupFn) { this._disconnectCleanupFn(); this._disconnectCleanupFn = null; }
    if (this._notifyCleanupFn)     { this._notifyCleanupFn();     this._notifyCleanupFn = null; }

    this._disconnectCleanupFn = _onDeviceDisconnect(device, () => {
      console.log(`[SecureDFU] disconnect event fired t=${Date.now()} pending ops: ${Object.keys(this._notifyFns).join(',') || 'none'}`);
      this._disconnectCleanupFn = null;
      const pending = this._notifyFns;
      this._notifyFns = {};
      this._controlChar = null;
      this._packetChar = null;
      for (const fn of Object.values(pending)) {
        if (fn?.reject) fn.reject(new Error('Device disconnected'));
      }
    });

    const ch = characteristics ?? await this._gattConnect(device);
    this.log(`found ${ch.length} characteristic(s)`);

    this._packetChar = ch.find(c => c.uuid === PACKET_UUID);
    if (!this._packetChar) throw new Error("Unable to find packet characteristic");
    this.log("found packet characteristic");

    this._controlChar = ch.find(c => c.uuid === CONTROL_UUID);
    if (!this._controlChar) throw new Error("Unable to find control characteristic");
    this.log("found control characteristic");

    if (!this._controlChar.properties.notify && !this._controlChar.properties.indicate) {
      throw new Error("Control characteristic does not allow notifications");
    }

    await this._controlChar.startNotifications();
    this._notifyCleanupFn = _onNotify(this._controlChar, this.handleNotification.bind(this));
    this.log("enabled control notifications");

    // Disable PRN to avoid interleaving async receipt notifications with
    // explicit checksum responses on the same opcode (0x03).
    try {
      const view = new DataView(new ArrayBuffer(2));
      view.setUint16(0, 0, LITTLE_ENDIAN);
      await this.sendControl(OPERATIONS.RECEIPT_NOTIFICATIONS, view.buffer);
      this.log("receipt notifications disabled (PRN=0)");
    } catch (err) {
      this.log("failed to disable receipt notifications: " + err.message);
    }
  }

  async _gattConnect(device, serviceUUID = SecureDfu.SERVICE_UUID) {
    const srv = device.gatt.connected ? device.gatt : await device.gatt.connect();
    this.log("connected to gatt server");
    const service = await srv.getPrimaryService(serviceUUID).catch(() => { throw new Error("Unable to find DFU service"); });
    this.log("found DFU service");
    return service.getCharacteristics();
  }

  handleNotification(event) {
    const view = new DataView(event.target.value.buffer);
    const rawBytes = Array.from(new Uint8Array(view.buffer)).map(b => '0x' + b.toString(16).padStart(2,'0')).join(' ');
    console.log(`[SecureDFU] notification: ${rawBytes}`);
    if (OPERATIONS.RESPONSE.indexOf(view.getUint8(0)) < 0) {
      throw new Error("Unrecognised control characteristic response notification");
    }

    const operation = view.getUint8(1);
    if (!this._notifyFns[operation]) return;

    const result = view.getUint8(2);
    let error = null;

    if (result === 0x01) {
      const data = new DataView(view.buffer, 3);
      this._resolveNotify(operation, data);
      return;
    } else if (result === 0x0B) {
      const code = view.getUint8(3);
      error = `Error: ${EXTENDED_ERROR[code] || 'Unknown extended error'}`;
    } else {
      error = `Error: ${RESPONSE[result] || 'Unknown response'}`;
    }

    if (error) {
      this.log(`notify: ${error}`);
      console.error(`[SecureDFU] notify error op=0x${operation.toString(16)}: ${error}`);
      if (this._notifyFns[operation]) {
        this._rejectNotify(operation, error);
      }
    }
  }

  _resolveNotify(op, data) {
    const fn = this._notifyFns[op];
    if (fn) { fn.resolve(data); delete this._notifyFns[op]; }
  }
  _rejectNotify(op, err) {
    const fn = this._notifyFns[op];
    if (fn) { fn.reject(err); delete this._notifyFns[op]; }
  }

  async sendOperation(characteristic, operation, buffer) {
    const size = operation.length + (buffer ? buffer.byteLength : 0);
    const value = new Uint8Array(size);
    value.set(operation);
    if (buffer) {
      const data = new Uint8Array(buffer);
      value.set(data, operation.length);
    }

    this._notifyFns[operation[0]] = { resolve: null, reject: null, value };

    const write = async () => {
      const writeMethod = characteristic.writeValueWithResponse.bind(characteristic);
      return this._writePacketWithRetry(writeMethod, value);
    };

    return new Promise((resolve, reject) => {
      this._notifyFns[operation[0]].resolve = resolve;
      this._notifyFns[operation[0]].reject  = reject;
      write().catch((err) => {
        delete this._notifyFns[operation[0]];
        reject(err);
      });
    });
  }

  sendControl(operation, buffer) {
    return new Promise((resolve, reject) => {
      this.sendOperation(this._controlChar, operation, buffer)
        .then(resp => setTimeout(() => resolve(resp), this._delay))
        .catch(err => reject(err));
    });
  }

  transferInit(buffer) {
    return this.transfer(buffer, 'init', OPERATIONS.SELECT_COMMAND, OPERATIONS.CREATE_COMMAND);
  }

  transferFirmware(buffer) {
    return this.transfer(buffer, 'firmware', OPERATIONS.SELECT_DATA, OPERATIONS.CREATE_DATA);
  }

  transfer(buffer, type, selectType, createType) {
    return this.sendControl(selectType)
      .then(response => {
        // Nordic SELECT response layout: max_size(4) | offset(4) | crc(4)
        const maxSize = response.getUint32(0, LITTLE_ENDIAN);
        const offset  = response.getUint32(4, LITTLE_ENDIAN);
        const crc     = response.getUint32(8, LITTLE_ENDIAN);

        if (type === 'init' && offset === buffer.byteLength && this.checkCrc(buffer, crc)) {
          this.log('init packet already available, skipping transfer');
          return;
        }

        // If init packet appears complete but CRC mismatches (stale data from
        // a previous DFU), restart from offset 0 to force a full overwrite.
        const effectiveOffset = (type === 'init' && offset >= buffer.byteLength) ? 0 : offset;

        this.progress(0, buffer.byteLength, type);
        return this.transferObject(buffer, createType, maxSize, effectiveOffset);
      });
  }

  transferObject(buffer, createType, maxSize, offset, crcFailStreak = 0) {
    const MAX_CRC_FAIL_STREAK = 6;
    if (crcFailStreak >= MAX_CRC_FAIL_STREAK) {
      throw new Error(`Object validation failed ${MAX_CRC_FAIL_STREAK} times at offset ${offset}`);
    }

    const start = offset - offset % maxSize;
    const end = Math.min(start + maxSize, buffer.byteLength);
    const view = new DataView(new ArrayBuffer(4));
    view.setUint32(0, end - start, LITTLE_ENDIAN);

    return this.sendControl(createType, view.buffer)
      .then(() => this.transferData(buffer.slice(start, end), buffer.byteLength, 0, start))
      .then(() => this.sendControl(OPERATIONS.CACULATE_CHECKSUM))
      .then(response => {
        const crc = response.getUint32(4, LITTLE_ENDIAN);
        const transferred = response.getUint32(0, LITTLE_ENDIAN);
        const data = buffer.slice(0, transferred);

        if (this.checkCrc(data, crc)) {
          this.log(`written ${transferred} bytes`);
          const execT0 = Date.now();
          console.log(`[SecureDFU] CRC OK, sending EXECUTE t=${execT0} (transferred=${transferred}, type=${createType[1]})`);
          return this.sendControl(OPERATIONS.EXECUTE)
            .then(() => { console.log(`[SecureDFU] EXECUTE succeeded dt=${Date.now()-execT0}ms (transferred=${transferred})`); return { transferred, ok: true }; })
            .catch(err => { console.error(`[SecureDFU] EXECUTE failed dt=${Date.now()-execT0}ms: ${err}`); throw err; });
        } else {
          this.log('object failed to validate');
          // Slow down slightly after CRC failures; fast command writes can
          // overrun BlueZ/Web Bluetooth flow control on some stacks.
          if (this._delay < 10) this._delay = 10;
          return { transferred, ok: false };
        }
      })
      .then(({ transferred, ok }) => {
        if (!ok && transferred <= start) {
          return this.transferObject(buffer, createType, maxSize, start, crcFailStreak + 1);
        }

        if (end < buffer.byteLength || !ok) {
          const nextStreak = ok ? 0 : crcFailStreak + 1;
          return this.transferObject(buffer, createType, maxSize, transferred, nextStreak);
        } else {
          this.log('transfer complete');
        }
      });
  }

  cancel() {
    this._abortRequested = true;
    this.log('transfer cancellation requested');
  }

  setReliableMode(enabled) {
    this._reliableMode = !!enabled;
    this.log(`Reliable mode ${this._reliableMode ? 'enabled' : 'disabled'}`);
  }

  transferData(data, totalBytes, start = 0, globalOffset = 0) {
    if (this._abortRequested) {
      throw new Error('Transfer cancelled by user');
    }
    const end = Math.min(start + PACKET_SIZE, data.byteLength);
    const packet = data.slice(start, end);

    const writeMethod = this._reliableMode
      ? this._packetChar.writeValueWithResponse.bind(this._packetChar)
      : this._packetChar.writeValueWithoutResponse.bind(this._packetChar);

    return this._writePacketWithRetry(writeMethod, new Uint8Array(packet))
      .then(() => this.delayPromise(this._delay))
      .then(() => {
        this.progress(globalOffset + end, totalBytes, 'firmware');
        if (end < data.byteLength) {
          return this.transferData(data, totalBytes, end, globalOffset);
        }
      });
  }

  async _writePacketWithRetry(writeMethod, chunk) {
    const maxAttempts = 6;
    let lastErr;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await writeMethod(chunk);
      } catch (err) {
        lastErr = err;
        if (!this._isTransientWriteError(err)) throw err;
        await this.delayPromise(10 * (attempt + 1));
      }
    }
    throw lastErr;
  }

  _isTransientWriteError(err) {
    const type = err?.type || '';
    const msg = String(err?.message || err || '');
    return type === 'org.bluez.Error.InProgress' || /in progress/i.test(msg);
  }

  checkCrc(buffer, crc) {
    if (!this._crc32) {
      this.log('crc32 not found, skipping CRC check');
      return true;
    }
    return crc === this._crc32.buf(new Uint8Array(buffer));
  }

  delayPromise(delay) {
    return new Promise(resolve => setTimeout(resolve, delay));
  }

  /** Update a connected device. Device should already be in bootloader mode. */
  async update(device, init, firmware) {
    if (!device) throw new Error('Device not specified');
    if (!init) throw new Error('Init not specified');
    if (!firmware) throw new Error('Firmware not specified');

    try {
      await this.connect(device);
      this.log('transferring init');
      await this.transferInit(init);
      this.log('transferring firmware');
      await this.transferFirmware(firmware);
      this.log('complete, disconnecting...');
    } catch (error) {
      if (this._delay === 0) {
        this.log('DFU update failed, but delay=0. Trying again with delay=10...');
        this._delay = 10;
        return this.update(device, init, firmware);
      }
      throw error;
    }
  }

  /** Trigger buttonless DFU on an app-mode device, return true if a reconnect is needed.
   *  If `characteristics` is provided, use them directly instead of re-discovering.
   */
  async triggerButtonless(device, withBonds = false, characteristics = null) {
    const buttonUuid = withBonds ? BUTTON_BONDS_UUID : BUTTON_UUID;
    const ch = characteristics ?? await this._gattConnect(device, SecureDfu.SERVICE_UUID);
    const buttonChar = ch.find(c => c.uuid === buttonUuid);
    if (!buttonChar) {
      // If control+packet are already present, we're already in bootloader mode.
      const hasControl = ch.find(c => c.uuid === CONTROL_UUID);
      const hasPacket  = ch.find(c => c.uuid === PACKET_UUID);
      if (hasControl && hasPacket) return false;
      throw new Error('Unsupported device — neither DFU control nor buttonless characteristic found');
    }

    if (!buttonChar.properties.notify && !buttonChar.properties.indicate) {
      throw new Error('Buttonless characteristic does not allow notifications');
    }

    await buttonChar.startNotifications();
    return new Promise((resolve, reject) => {
      const cleanupDisconnect = _onDeviceDisconnect(device, () => {
        cleanupNotify();
        resolve();
      });
      const cleanupNotify = _onNotify(buttonChar, (ev) => this.handleNotification(ev));

      const sendBuf = new Uint8Array(OPERATIONS.BUTTON_COMMAND);
      buttonChar.writeValueWithResponse(sendBuf).then(() => {
        this.log('sent DFU mode command');
      }).catch(err => {
        cleanupDisconnect();
        cleanupNotify();
        reject(err);
      });
    }).then(() => {
      // Device disconnected; return true to indicate reconnect needed
      return true;
    });
  }
}
