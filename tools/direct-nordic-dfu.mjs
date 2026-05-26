#!/usr/bin/env node
// Direct Nordic Secure DFU test — connects to bootloader directly.

import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createBluetooth } from 'node-ble';

import { NordicProvider } from '../nordic/nordic-provider.js';
import { SecureDfuPackage } from '../nordic/package.js';
import JSZip from '../vendor/jszip.js';
import { BleCharacteristic } from './ble-characteristic.mjs';

EventEmitter.defaultMaxListeners = 0;

const DEVICE_NAME = 'Nordic_Buttonless';

function step(msg) { console.log(`\n▶ ${msg}`); }
function info(msg)  { console.log(`  ${msg}`); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findDevice(adapter, name, maxWait = 30000) {
  const deadline = Date.now() + maxWait;
  while (Date.now() < deadline) {
    for (const m of await adapter.devices()) {
      try {
        const dev = await adapter.getDevice(m);
        let n1 = '', n2 = '';
        try { n1 = await dev.getName(); } catch {}
        try { n2 = await dev.getAlias(); } catch {}
        if (n1 === name || n1.includes(name) || n2 === name || n2.includes(name)) return dev;
      } catch {}
    }
    await sleep(1000);
  }
  throw new Error(`No BLE device named "${name}" found within ${maxWait}ms`);
}

async function connectWithRetry(device, attempts = 8) {
  for (let i = 1; i <= attempts; i++) {
    try { await device.connect(); return; }
    catch (err) {
      if (i === attempts) throw new Error(`connect failed: ${err.message}`);
      await sleep(2000);
    }
  }
}

async function buildSession(device) {
  await connectWithRetry(device);
  const gatt = await device.gatt();
  const ALL_UUIDS = await gatt.services();
  info(`Services: ${ALL_UUIDS.map(u=>u.toUpperCase()).join(', ')}`);

  // Normalize names — node-ble returns 0000FE59-0000...
  const nordicSvcUuid = ALL_UUIDS.find(u => u.replace(/-/g,'').toLowerCase().endsWith('fe59'))
                     || ALL_UUIDS.find(u => u.replace(/-/g,'').toLowerCase().includes('fe59'));
  if (!nordicSvcUuid) throw new Error('Nordic DFU service not found');

  const service = await gatt.getPrimaryService(nordicSvcUuid);
  const charUuids = await service.characteristics();
  info(`Characteristics: ${charUuids.map(u=>u.toUpperCase()).join(', ')}`);

  // Find control (8ec90001) and packet (8ec90002) by last segment
  const controlUuid = charUuids.find(u => u.toLowerCase().includes('8ec90001'));
  const packetUuid  = charUuids.find(u => u.toLowerCase().includes('8ec90002'));
  if (!controlUuid) throw new Error('Control point characteristic not found');
  if (!packetUuid)  throw new Error('Packet characteristic not found');

  const controlChar = await service.getCharacteristic(controlUuid);
  const packetChar  = await service.getCharacteristic(packetUuid);

  const charMap = new Map();
  for (const uuid of charUuids) {
    const rc = await service.getCharacteristic(uuid);
    charMap.set(uuid, new BleCharacteristic(rc, uuid));
  }
  const services = new Map();
  services.set(nordicSvcUuid, { service, characteristics: charMap });
  return { device, server: gatt, services, disconnect: () => device.disconnect() };
}

async function main() {
  const zipPath = process.argv[2];
  if (!zipPath) {
    console.error('usage: node direct-nordic-dfu.mjs <path-to-package.zip>');
    process.exit(2);
  }

  const zipBuffer = readFileSync(resolve(zipPath));
  info(`ZIP package: ${zipPath} (${(zipBuffer.byteLength/1024).toFixed(1)} KB)`);

  const pkg = new SecureDfuPackage(
    zipBuffer.buffer.slice(zipBuffer.byteOffset, zipBuffer.byteOffset + zipBuffer.byteLength)
  );
  await pkg.load(JSZip);
  const image = await pkg.getAppImage() ?? await pkg.getBaseImage();
  if (!image) throw new Error('No image found in ZIP package');
  info(`manifest type: ${image.type}, init=${image.initFile}, image=${image.imageFile}`);

  const { bluetooth, destroy } = createBluetooth();
  try {
    const adapter = await bluetooth.defaultAdapter();
    if (!(await adapter.isPowered().catch(() => true))) throw new Error('BLE adapter not powered');

    step(`Looking for "${DEVICE_NAME}"`);
    const device = await findDevice(adapter, DEVICE_NAME, 30_000);
    const mac = await device.getAddress();
    info(`Found ${await device.getName()} @ ${mac}`);

    step('Connecting');
    let session = await buildSession(device);

    const provider = new NordicProvider();
    let needsReconnect = false;

    provider.addEventListener('progress', (e) => {
      const pct = Math.floor((e.detail.currentBytes / e.detail.totalBytes) * 100);
      process.stdout.write(`\r  Uploading ${pct}%`);
    });
    provider.addEventListener('log', (e) => {
      const { message, level } = e.detail;
      if (level === 'error' || level === 'info') info(`[${level}] ${message}`);
    });
    provider.addEventListener('needs-reconnect', () => { needsReconnect = true; });

    // Attach skips triggerDfuMode because we're already in DFU
    await provider.attach(session);
    info(`Attached (needsReconnect=${needsReconnect})`);

    if (!needsReconnect) {
      info('Already in bootloader mode — continuing');
    } else {
      step('Phase 1: device rebooted into bootloader');
      try { await device.disconnect(); } catch {}
      await sleep(3000);
      step('Phase 2: rescanning');
      const newDevice = await findDevice(adapter, DEVICE_NAME, 30_000);
      session = await buildSession(newDevice);
      await provider.attach(session);
      info('Re-attached in bootloader mode');
    }

    step('Loading firmware package');
    await provider.loadFirmware(new Uint8Array(zipBuffer));
    info('Package parsed');

    step('Starting DFU transfer');
    const t0 = Date.now();
    try {
      await provider.runUpdate();
      const elapsed = (Date.now() - t0) / 1000;
      process.stdout.write('\n');
      info(`DFU complete in ${elapsed.toFixed(1)}s`);
    } catch (err) {
      process.stdout.write('\n');
      throw err;
    }

    await provider.detach();
    try { await device.disconnect(); } catch {}
    console.log(`\n✓ PASS — Nordic Secure DFU (${(zipBuffer.byteLength/1024).toFixed(1)} KB)`);
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
