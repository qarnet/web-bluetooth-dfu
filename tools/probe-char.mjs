import { createBluetooth } from 'node-ble';

async function main() {
  const { bluetooth, destroy } = createBluetooth();
  try {
    const adapter = await bluetooth.defaultAdapter();
    const dev = await adapter.getDevice('D7:E7:59:AB:C2:CF');
    await dev.connect();
    const g = await dev.gatt();
    await g.init();
    const s = await g.getPrimaryService('0000fe59-0000-1000-8000-00805f9b34fb');
    await s.init();
    for (const uuid of await s.characteristics()) {
      const c = await s.getCharacteristic(uuid);
      console.log('uuid:', uuid, 'typeof=', typeof uuid, 'charPath:', c.characteristic);
    }
    await dev.disconnect();
  } finally { destroy(); }
}
main().catch(e => { console.error(e); process.exit(1); });
