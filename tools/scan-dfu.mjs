import { createBluetooth } from 'node-ble';

async function main() {
  const { bluetooth, destroy } = createBluetooth();
  try {
    const adapter = await bluetooth.defaultAdapter();
    await adapter.startDiscovery();
    console.log('Scanning 20s for BLE devices...');
    for (let i = 0; i < 20; i++) {
      const devices = await adapter.devices();
      for (const m of devices) {
        try {
          const dev = await adapter.getDevice(m);
          const name = await dev.getName().catch(() => null);
          if (name) console.log(i, name, await dev.getAddress());
        } catch (e) {
          /* skip */
        }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    console.log('Scan done.');
  } finally {
    destroy();
  }
}
main().catch(console.error);
