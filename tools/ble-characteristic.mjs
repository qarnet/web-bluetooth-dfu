// Adapts a node-ble GATT characteristic to the slice of the Web Bluetooth
// BluetoothRemoteGATTCharacteristic API that smp/protocol.js's SmpClient uses.
// This is what lets the harness run the app's real SMP modules unchanged.

export class BleCharacteristic {
  #char;
  #listeners = new Set();

  constructor(nodeBleCharacteristic) {
    this.#char = nodeBleCharacteristic;
    this.#char.on('valuechanged', (buffer) => this.#dispatch(buffer));
  }

  addEventListener(type, fn) {
    if (type === 'characteristicvaluechanged') this.#listeners.add(fn);
  }

  removeEventListener(type, fn) {
    if (type === 'characteristicvaluechanged') this.#listeners.delete(fn);
  }

  #dispatch(buffer) {
    // A Node Buffer's .buffer is a shared pool — copy into a fresh, exact-length
    // ArrayBuffer so SmpClient's `new Uint8Array(event.target.value.buffer)`
    // sees only this notification's bytes.
    const ab = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    );
    const event = { target: { value: new DataView(ab) } };
    for (const fn of this.#listeners) fn(event);
  }

  async startNotifications() {
    await this.#char.startNotifications();
    return this;
  }

  async stopNotifications() {
    await this.#char.stopNotifications();
    return this;
  }

  // SMP requests are GATT Write Without Response — node-ble's { type: 'command' }.
  async writeValueWithoutResponse(chunk) {
    await this.#char.writeValue(Buffer.from(chunk), { type: 'command' });
  }
}
