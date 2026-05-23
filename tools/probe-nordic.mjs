import { createBluetooth } from 'node-ble';

async function main() {
  const { bluetooth, destroy } = createBluetooth();
  try {
    const adapter = await bluetooth.defaultAdapter();
    const dev = await adapter.getDevice('D7:E7:59:AB:C2:CF');
    await dev.connect();
    const gatt = await dev.gatt();
    const service = await gatt.getPrimaryService('0000fe59-0000-1000-8000-00805f9b34fb');
    const chars = await service.getCharacteristics();
    for (const uuid of chars) {
      const c = await service.getCharacteristic(uuid);
      console.log('UUID prop:', c.characteristic);
      const flags = await c.getFlags();
      console.log('UUID', uuid, 'flags:', flags);
    }
    await dev.disconnect();
  } finally { destroy(); }
}
main().catch(e => { console.error(e); process.exit(1); });
