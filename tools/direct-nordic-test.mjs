#!/usr/bin/env node
// Direct Nordic Secure DFU test — skips app trigger (device already in bootloader).
// Usage: node direct-nordic-test.mjs <path-to-package.zip>

import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createBluetooth } from 'node-ble';

import { NordicProvider } from '../nordic/nordic-provider.js';
import { SecureDfuPackage } from '../nordic/package.js';
import JSZip from '../vendor/jszip.js';
import { BleCharacteristic } from './ble-characteristic.mjs';
import { REGISTRY } from '../core/registry.js';

const NORDIC_SERVICE_UUID = REGISTRY.nordic.serviceUuid;
EventEmitter.defaultMaxListeners = 0;

function step(msg)  { console.log(`\n▶ ${msg}`); }
function info(msg)  { console.log(`  ${msg}`); }

function drawProgress(current, total) {
  const pct = Math.max(0, Math.min(100, total ? Math.floor((current / total) * 100) : 0));
  const width = 30;
  const filled = Math.round((pct / 100) * width);
  const bar = '#'.repeat(filled) + '-'.repeat(width - filled);
  process.stdout.write(`\r  [${bar}] ${String(pct).padStart(3)}%  ${(current/1024).toFixed(1)}/${(total/1024).toFixed(1)} KB`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Discover-on / discover-off wrapper to avoid D-Bus match-rule leaks. */
async function* discover(adapter) {
  if (!(await adapter.isDiscovering())) await adapter.startDiscovery();
  try {
    while (true) {
      yield await adapter.devices();
      await sleep(500);
    }
  } finally {
    try { await adapter.stopDiscovery(); } catch { /* ignore */ }
  }
}

async function findDevice(adapter, name, maxWait = 30000) {
  const deadline = Date.now() + maxWait;
  const disc = discover(adapter);
  try {
    while (Date.now() < deadline) {
      const { value: devPaths, done } = await disc.next();
      if (done) break;
      for (const m of devPaths) {
        try {
          const dev = await adapter.getDevice(m);
          const advName = (await dev.getName().catch(() => '')) || (await dev.getAlias().catch(() => ''));
          if (advName === name || advName.includes(name)) return dev;
        } catch { /* next */ }
      }
      await sleep(1000);
    }
  } finally {
    await disc.return();
  }
  throw new Error(`No BLE device named "${name}" found within ${maxWait}ms`);
}

async function connectWithRetry(device, attempts = 8) {
  for (let i = 1; i <= attempts; i++) {
    try { await device.connect(); return; }
    catch (err) {
      if (i === attempts) throw new Error(`connect failed after ${attempts} tries: ${err.message}`);
      await sleep(2000);
    }
  }
}

async function buildSession(device) {
  await connectWithRetry(device);
  const gatt = await device.gatt();
  const service = await gatt.getPrimaryService(NORDIC_SERVICE_UUID);
  const charUuids = await service.characteristics();
  const charMap = new Map();
  for (const uuid of charUuids) {
    const rc = await service.getCharacteristic(uuid);
    charMap.set(uuid, new BleCharacteristic(rc, uuid));
  }
  const services = new Map();
  services.set(NORDIC_SERVICE_UUID, { service, characteristics: charMap });
  return { device, server: gatt, services, disconnect: () => device.disconnect() };
}

async function main() {
  const zipPath = process.argv[2];
  if (!zipPath) {
    console.error('usage: node direct-nordic-test.mjs <path-to-package.zip>');
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

  const bootloaderName = 'DfuTarg';

  const { bluetooth, destroy } = createBluetooth();
  try {
    const adapter = await bluetooth.defaultAdapter();
    if (!(await adapter.isPowered().catch(() => true))) {
      throw new Error('BLE adapter not powered');
    }

    // ▶ Phase 1: connect directly to bootloader
    step(`Phase 1: scanning for bootloader "${bootloaderName}"`);
    let device = await findDevice(adapter, bootloaderName, 30_000);
    let mac = await device.getAddress();
    info(`found bootloader "${bootloaderName}" @ ${mac}`);

    step('Phase 1: connecting to bootloader');
    let session = await buildSession(device);

    const provider = new NordicProvider();
    provider.addEventListener('progress', (e) => {
      drawProgress(e.detail.currentBytes, e.detail.totalBytes);
    });
    provider.addEventListener('log', (e) => {
      const { message, level } = e.detail;
      if (level === 'error' || level === 'info') info(`[${level}] ${message}`);
    });
    provider.addEventListener('needs-reconnect', () => {});

    await provider.attach(session);

    step('Loading firmware package');
    await provider.loadFirmware(new Uint8Array(zipBuffer));
    info('package parsed');

    // ▶ Phase 2: run the DFU transfer
    step('Phase 2: running DFU transfer');
    const t0 = Date.now();
    try {
      await provider.runUpdate();
    } catch (updateErr) {
      process.stdout.write('\n');
      throw updateErr;
    }

    process.stdout.write('\n');
    info(`DFU complete in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    await provider.detach();
    try { await device.disconnect(); } catch { /* ignore */ }
    console.log(`\n✓ PASS — Nordic Secure DFU direct-bootloader test complete.`);
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
