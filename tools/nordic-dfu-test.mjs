#!/usr/bin/env node
// Headless BLE Nordic Secure DFU test harness.
//
// Connects over real BLE (node-ble / BlueZ) and runs the full DFU sequence
// by reusing the app's NordicProvider.
//
// Usage:  node nordic-dfu-test.mjs <path-to-package.zip>
// Env:    DEVICE_NAME (default "DfuTarg"), DEVICE_MAC (skip name scan)
// Exit:   0 = transfer complete, 1 = failure, 2 = bad usage.

import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { createBluetooth } from 'node-ble';

import { NordicProvider } from '../nordic/nordic-provider.js';
import { SecureDfuPackage } from '../nordic/package.js';
import JSZip from '../vendor/jszip.js';
import { BleCharacteristic } from './ble-characteristic.mjs';
import { REGISTRY } from '../core/registry.js';

const NORDIC_SERVICE_UUID = REGISTRY.nordic.serviceUuid;

// node-ble adds a D-Bus listener per discovered device — lift the default cap.
EventEmitter.defaultMaxListeners = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function step(msg)  { console.log(`\n▶ ${msg}`); }
function info(msg)  { console.log(`  ${msg}`); }
function drawProgress(current, total) {
  let pct = total ? Math.floor((current / total) * 100) : 0;
  pct = Math.max(0, Math.min(100, pct));
  const width = 30;
  const filled = Math.round((pct / 100) * width);
  const bar = '#'.repeat(filled) + '-'.repeat(width - filled);
  process.stdout.write(`\r  [${bar}] ${String(pct).padStart(3)}%  ${(current/1024).toFixed(1)}/${(total/1024).toFixed(1)} KB`);
}

async function findDevice(adapter, { name, mac }) {
  if (!(await adapter.isDiscovering())) await adapter.startDiscovery();
  if (mac) {
    try {
      return await adapter.waitDevice(mac.toUpperCase());
    } catch {
      // fall through to name-based scan
    }
  }

  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    for (const m of await adapter.devices()) {
      const dev = await adapter.getDevice(m);
      let advName = null;
      try { advName = await dev.getName(); }
      catch { try { advName = await dev.getAlias(); } catch { /* no name yet */ } }
      if (advName === name) return dev;
    }
    await sleep(1000);
  }
  throw new Error(`No BLE device named "${name}" found within 25s`);
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

/** Build the session object NordicProvider.attach() expects. */
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

/** Remove stale BlueZ entry via bluetoothctl so D-Bus path is clean. */
function removeBlueZ(mac) {
  try {
    execSync(`bluetoothctl remove ${mac.toUpperCase()}`, { stdio: 'ignore', timeout: 5000 });
  } catch { /* ignore failure (may not exist) */ }
}

async function main() {
  const zipPath = process.argv[2];
  if (!zipPath) {
    console.error('usage: node nordic-dfu-test.mjs <path-to-package.zip>');
    process.exit(2);
  }

  const zipBuffer = readFileSync(resolve(zipPath));
  info(`ZIP package: ${zipPath} (${(zipBuffer.byteLength/1024).toFixed(1)} KB)`);

  // Structural sanity first
  const pkg = new SecureDfuPackage(zipBuffer.buffer.slice(zipBuffer.byteOffset, zipBuffer.byteOffset + zipBuffer.byteLength));
  await pkg.load(JSZip);
  const image = await pkg.getAppImage() ?? await pkg.getBaseImage();
  if (!image) throw new Error('No image found in ZIP package');
  info(`manifest type: ${image.type}, init=${image.initFile}, image=${image.imageFile}`);

  const appName = process.env.APP_NAME || 'Nordic_Buttonless';
  const bootloaderName = process.env.BOOTLOADER_NAME || 'DfuTest';

  const { bluetooth, destroy } = createBluetooth();
  try {
    const adapter = await bluetooth.defaultAdapter();
    if (!(await adapter.isPowered().catch(() => true))) {
      throw new Error('BLE adapter not powered — run: bluetoothctl power on');
    }

    step('Scanning for device');
    let device = await findDevice(adapter, { name: appName });
    let mac = await device.getAddress();
    info(`found "${appName}" @ ${mac}`);

    step('Connecting');
    let session = await buildSession(device);

    const provider = new NordicProvider();
    let needsReconnect = false;

    provider.addEventListener('progress', (e) => {
      const { currentBytes, totalBytes } = e.detail;
      drawProgress(currentBytes, totalBytes);
    });
    provider.addEventListener('log', (e) => {
      const { message, level } = e.detail;
      if (level === 'error' || level === 'info') info(`[${level}] ${message}`);
    });
    provider.addEventListener('needs-reconnect', () => {
      needsReconnect = true;
    });

    await provider.attach(session);

    if (needsReconnect) {
      step('Device rebooted into bootloader — cleaning up stale BlueZ entry');
      await provider.detach();
      // Do not call device.disconnect() here — device already rebooted
      removeBlueZ(mac);
      await sleep(3000);

      // Must restart discovery after remove for BlueZ to re-create Device1
      if (await adapter.isDiscovering()) await adapter.stopDiscovery();
      await adapter.startDiscovery();

      let reconnectAttempts = 10;
      while (reconnectAttempts > 0) {
        try {
          device = await findDevice(adapter, { name: bootloaderName });
          mac = await device.getAddress();
          info(`found bootloader "${bootloaderName}" @ ${mac}`);
          session = await buildSession(device);
          await provider.attach(session);
          break;
        } catch (err) {
          reconnectAttempts--;
          if (reconnectAttempts === 0) throw err;
          info(`reconnect attempt failed: ${err.message}, retrying...`);
          await sleep(3000);
        }
      }
    }

    step('Loading firmware package');
    await provider.loadFirmware(new Uint8Array(zipBuffer));
    info('package parsed');

    step('Running DFU transfer');
    const t0 = Date.now();
    try {
      await provider.runUpdate();
      process.stdout.write('\n');
      info(`DFU complete in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } catch (updateErr) {
      process.stdout.write('\n');
      info(`DFU transfer threw: ${JSON.stringify(updateErr)} (type=${typeof updateErr})`);
      throw updateErr;
    }

    await provider.detach();
    await device.disconnect().catch(() => {});

    console.log(`\n✓ PASS — Nordic Secure DFU complete.`);
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
