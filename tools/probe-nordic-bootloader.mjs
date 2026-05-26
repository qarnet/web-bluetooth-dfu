#!/usr/bin/env node
// Connect to Nordic bootloader and verify service/char UUIDs.

import { createBluetooth } from 'node-ble';
import { readFileSync } from 'node:fs';
import { BleCharacteristic } from './ble-characteristic.mjs';

const NORDIC_SERVICE_UUID = '0000fe59-0000-1000-8000-00805f9b34fb';

async function main() {
  const { bluetooth, destroy } = createBluetooth();
  try {
    const adapter = await bluetooth.defaultAdapter();
    if (!await adapter.isPowered()) { console.log('BT not powered'); return; }
    await adapter.startDiscovery();
    let dev;
    for (let i = 0; i < 15; i++) {
      for (const m of await adapter.devices()) {
        dev = await adapter.getDevice(m);
        let n = '';
        try { n = await dev.getName(); } catch {}
        try { if (!n) n = await dev.getAlias(); } catch {}
        if (n === 'Nordic_Buttonless') break;
        dev = null;
      }
      if (dev) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    await adapter.stopDiscovery();
    if (!dev) { console.log('Device not found'); return; }
    console.log(`Found ${await dev.getName()} @ ${await dev.getAddress()}`);

    console.log('Connecting...');
    await dev.connect();
    const gatt = await dev.gatt();
    console.log('Connected, enumerating services...');

    const svcUuids = await gatt.services();
    console.log(`Found ${svcUuids.length} services: ${svcUuids.map(u=>u.toUpperCase()).join(', ')}`);

  let nordicSvc = null;
  for (const su of svcUuids) {
    const normalized = su.replace(/-/g, '').toLowerCase();
    if (normalized === NORDIC_SERVICE_UUID.replace(/-/g, '').toLowerCase()) nordicSvc = su;
  }
    if (!nordicSvc) {
      console.log(`Nordic DFU service (${NORDIC_SERVICE_UUID.toUpperCase()}) NOT FOUND`);
      return;
    }

    const svc = await gatt.getPrimaryService(NORDIC_SERVICE_UUID);
    const charUuids = await svc.characteristics();
    console.log(`Nordic DFU service found! Characteristics: ${charUuids.map(u=>u.toUpperCase()).join(', ')}`);

    const controlUuid = charUuids.find(u => u.toLowerCase().includes('8ec90001'));
    const packetUuid  = charUuids.find(u => u.toLowerCase().includes('8ec90002'));

    if (!controlUuid || !packetUuid) {
      console.log(`Missing control (${controlUuid}) or packet (${packetUuid}) char`);
      return;
    }

    const controlChar = await svc.getCharacteristic(controlUuid);
    console.log(`Control char: ${controlUuid.toUpperCase()} flags=${await controlChar.getFlags()}`);
    const packetChar  = await svc.getCharacteristic(packetUuid);
    console.log(`Packet char:  ${packetUuid.toUpperCase()} flags=${await packetChar.getFlags()}`);

    // Now, let's try writing to the control point and reading notifications
    const mockControl = new BleCharacteristic(controlChar, controlUuid);
    console.log('\nTrying write with response...');
    try {
      await mockControl.writeValueWithResponse(new Uint8Array([0x06])); // Select command
      console.log('Write succeeded!');
    } catch (e) {
      console.log('Write failed:', e.message);
    }

  } finally {
    destroy();
  }
}

main().catch(e => console.error(e));
