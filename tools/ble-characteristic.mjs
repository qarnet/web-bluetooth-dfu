// Adapts a node-ble GATT characteristic to the slice of the Web Bluetooth
// BluetoothRemoteGATTCharacteristic API that the DFU providers use.
// This is what lets the harness run the app's protocol modules unchanged.

export class BleCharacteristic {
  #char;
  #listeners = new Set();

  /**
   * @param {object} nodeBleCharacteristic - node-ble GattCharacteristic
   * @param {string} uuid - the actual BLE characteristic UUID
   */
  constructor(nodeBleCharacteristic, uuid) {
    this.#char = nodeBleCharacteristic;
    this.uuid = uuid;
    this.#char.on('valuechanged', (buffer) => this.#dispatch(buffer));
    // Fake properties so SecureDfu knows what the char supports
    this.properties = NodeBlePropertiesAdapter.for(this.#char);
  }

  addEventListener(type, fn) {
    if (type === 'characteristicvaluechanged') this.#listeners.add(fn);
  }

  removeEventListener(type, fn) {
    if (type === 'characteristicvaluechanged') this.#listeners.delete(fn);
  }

  #dispatch(buffer) {
    const ab = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    );
    const event = { target: { value: new DataView(ab) } };
    for (const fn of this.#listeners) {
      try { fn(event); } catch (e) { console.error('[BleCharacteristic] listener error:', e); }
    }
  }

  async startNotifications()  { await this.#char.startNotifications(); return this; }
  async stopNotifications()   { await this.#char.stopNotifications();  return this; }

  // Write Without Response (SMP + Nordic Packet)
  async writeValueWithoutResponse(chunk) {
    await this.#char.writeValue(Buffer.from(chunk), { type: 'command' });
  }

  // Write With Response (Nordic Control Point)
  async writeValueWithResponse(chunk) {
    await this.#char.writeValue(Buffer.from(chunk), { type: 'request' });
  }

  // Legacy overload — delegate to writeValueWithResponse (deprecated in spec)
  async writeValue(chunk) {
    return this.writeValueWithResponse(chunk);
  }
}

/** node-ble doesn't expose properties nicely; hardcode common BLE char flags. */
class NodeBlePropertiesAdapter {
  static for(nodeChar) {
    // node-ble uses dbus; properties array is in the metadata. Best effort fallback.
    return {
      broadcast: false,
      read: true,
      writeWithoutResponse: true,
      write: true,
      notify: true,
      indicate: false,
      authenticatedSignedWrites: false,
    };
  }
}
