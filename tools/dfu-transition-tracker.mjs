#!/usr/bin/env node
// Minimal test: connect to Nordic Buttonless, trigger DFU, track name change.

import { createBluetooth } from 'node-ble';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { bluetooth, destroy } = createBluetooth();
  try {
    const adapter = await bluetooth.defaultAdapter();
    await adapter.startDiscovery();

    let oldMac = null;
    let foundDevice = null;

    console.log('Scanning 10s for Nordic_Buttonless...');
    for (let i = 0; i < 10; i++) {
      for (const m of await adapter.devices()) {
        try {
          const dev = await adapter.getDevice(m);
          const name =
            (await dev.getName().catch(() => '')) || (await dev.getAlias().catch(() => ''));
          if (name === 'Nordic_Buttonless') {
            foundDevice = dev;
            oldMac = m;
            break;
          }
        } catch {}
      }
      if (foundDevice) break;
      await sleep(1000);
    }

    if (!foundDevice) {
      console.log('Not found');
      return;
    }
    console.log(`Found: ${await foundDevice.getName()} @ ${oldMac}`);
    await foundDevice.connect();
    const gatt = await foundDevice.gatt();

    // List all services
    const svcs = await gatt.services();
    console.log(`Services: ${svcs.join(', ')}`);

    // Show device alias property
    try {
      console.log(`Device Alias: ${await adapter.getDevice(oldMac).then((d) => d.getAlias())}`);
    } catch {}

    await foundDevice.disconnect();
    console.log('Disconnected for DFU mode test...');

    // After disconnect, wait 10s and scan again
    await sleep(8000);
    console.log('Rescanning 10s after disconnect...');
    for (let i = 0; i < 10; i++) {
      for (const m of await adapter.devices()) {
        try {
          const dev = await adapter.getDevice(m);
          const name =
            (await dev.getName().catch(() => '')) || (await dev.getAlias().catch(() => ''));
          if (name) console.log(`  [${i}] ${m}: ${name}`);
        } catch {}
      }
      await sleep(1000);
    }
    await adapter.stopDiscovery();
  } finally {
    destroy();
  }
}

main().catch(console.error);
