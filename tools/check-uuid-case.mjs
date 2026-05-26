#!/usr/bin/env node
// Check UUID case from node-ble service.characteristics()

import { createBluetooth } from 'node-ble';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  const { bluetooth, destroy } = createBluetooth();
  try {
    const adapter = await bluetooth.defaultAdapter();
    await adapter.startDiscovery();
    let dev;
    for (let i = 0; i < 20; i++) {
      for (const m of await adapter.devices()) {
        try {
          dev = await adapter.getDevice(m);
          const n = (await dev.getName().catch(()=>'')) || (await dev.getAlias().catch(()=>''));
          if (n === 'Nordic_Buttonless') break;
          dev = null;
        } catch {}
      }
      if (dev) break;
      await sleep(1000);
    }
    await adapter.stopDiscovery();
    if (!dev) { console.log('Not found'); return; }

    await dev.connect();
    const gatt = await dev.gatt();
    const svcs = await gatt.services();
    for (const su of svcs) {
      const svc = await gatt.getPrimaryService(su);
      const chars = await svc.characteristics();
      console.log(`Service ${su.toUpperCase()}:`);
      for (const c of chars) {
        console.log(`  Char: "${c}"`);
        // Also get the flags
        const rc = await svc.getCharacteristic(c);
        console.log(`    flags: ${await rc.getFlags()}`);
      }
    }
    await dev.disconnect();
  } finally { destroy(); }
}

main().catch(e => console.error(e));
