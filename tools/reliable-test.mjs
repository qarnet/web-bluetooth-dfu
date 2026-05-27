#!/usr/bin/env node
// Quick test: run SMP DFU with RELIABLE=1 to verify reliable mode works end-to-end.
// Same as dfu-test.mjs but passes reliableMode=true to SmpProvider.

import { webcrypto } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createBluetooth } from 'node-ble';

import { SmpProvider } from '../smp/smp-provider.js';
import { SMP_SERVICE_UUID, SMP_CHAR_UUID } from '../bluetooth/connect.js';
import { BleCharacteristic } from './ble-characteristic.mjs';

globalThis.crypto ??= webcrypto;
EventEmitter.defaultMaxListeners = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function step(msg) {
  console.log(`\n▶ ${msg}`);
}
function info(msg) {
  console.log(`  ${msg}`);
}

async function findDevice(adapter, name) {
  if (!(await adapter.isDiscovering())) await adapter.startDiscovery();
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    for (const m of await adapter.devices()) {
      const dev = await adapter.getDevice(m);
      let advName = null;
      try {
        advName = await dev.getName();
      } catch {
        try {
          advName = await dev.getAlias();
        } catch {}
      }
      if (advName === name) return dev;
    }
    await sleep(1000);
  }
  throw new Error(`No BLE device named "${name}" found within 25s`);
}

async function connectWithRetry(device, attempts = 8) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await device.connect();
      return;
    } catch (err) {
      if (i === attempts) throw new Error(`connect failed after ${attempts} tries: ${err.message}`);
      await sleep(2000);
    }
  }
}

async function openSession(device) {
  await connectWithRetry(device);
  const gatt = await device.gatt();
  const service = await gatt.getPrimaryService(SMP_SERVICE_UUID);
  const characteristic = await service.getCharacteristic(SMP_CHAR_UUID);
  const charMap = new Map();
  charMap.set(SMP_CHAR_UUID, new BleCharacteristic(characteristic, SMP_CHAR_UUID));
  const services = new Map();
  services.set(SMP_SERVICE_UUID, { service, characteristics: charMap });
  return { device, server: gatt, services, disconnect: () => device.disconnect() };
}

async function main() {
  const binPath = process.argv[2];
  if (!binPath) {
    console.error('usage: node reliable-test.mjs <path-to-zephyr.signed.bin>');
    process.exit(2);
  }

  const fw = new Uint8Array(readFileSync(resolve(binPath)));
  const deviceName = 'Zephyr';

  step('Reliable mode test');
  info('This test uses writeValueWithResponse for every packet (slower but safer)');

  const { bluetooth, destroy } = createBluetooth();
  try {
    const adapter = await bluetooth.defaultAdapter();
    if (!(await adapter.isPowered().catch(() => true))) {
      throw new Error('BLE adapter not powered');
    }

    step('Scanning for device');
    let device = await findDevice(adapter, deviceName);
    const mac = await device.getAddress();
    info(`found "${deviceName}" @ ${mac}`);

    step('Connecting');
    let session = await openSession(device);

    // Create provider with reliable mode enabled
    const provider = new SmpProvider({ mtu: 244 });
    provider.setReliableMode(true);

    let progressCount = 0;
    provider.addEventListener('progress', () => {
      progressCount++;
    });
    provider.addEventListener('log', (e) => {
      // Log only non-upload messages to avoid noise
      if (!e.detail.message.includes('Upload')) {
        info(e.detail.message);
      }
    });

    await provider.attach(session);

    step('Reading image slots');
    let slots = await provider.readState();
    const before = slots.find((s) => s.slot === 0);
    info(`baseline: slot 0 version ${before.version}`);

    await provider.loadFirmware(fw);

    step('Uploading with reliable mode');
    const t0 = Date.now();
    await provider.runUpdate();
    const elapsed = (Date.now() - t0) / 1000;
    info(`upload+test+reset complete in ${elapsed.toFixed(1)}s`);
    info(`received ${progressCount} progress events`);

    await provider.detach();
    await device.disconnect().catch(() => {});

    step('Waiting for reboot, then reconnecting');
    await sleep(6000);
    device = await findDevice(adapter, deviceName);
    session = await openSession(device);
    await provider.attach(session);

    step('Verifying swapped image');
    slots = await provider.readState();
    const after = slots.find((s) => s.slot === 0);
    if (!after?.active) throw new Error('slot 0 not active after reboot');
    info(`slot 0 now runs version ${after.version}`);

    step('Confirming image');
    await provider.confirm();
    slots = await provider.readState();
    const final = slots.find((s) => s.slot === 0);
    if (!final?.confirmed) throw new Error('slot 0 not confirmed');

    await provider.detach();
    await device.disconnect().catch(() => {});

    console.log(`\n✓ PASS — reliable mode DFU succeeded in ${elapsed.toFixed(1)}s.`);
    console.log(`  (Compare with normal mode: typically ~45s for 200KB)`);
  } finally {
    destroy();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`\n✗ FAIL — ${err.message}`);
    process.exit(1);
  });
