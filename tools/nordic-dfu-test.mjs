#!/usr/bin/env node
// Headless BLE Nordic Secure DFU test harness.
//
// Connects over real BLE (node-ble / BlueZ) and runs the full DFU sequence
// by reusing the app's NordicProvider.
//
// Usage:  node nordic-dfu-test.mjs [--multi-image] <path-to-package.zip>
// Env:    APP_NAME (default "Nordic_Buttonless"), BOOTLOADER_NAME (default "DfuTest")
//
// Note: SDK 17.1.0 stock sample's sdk_config.h sets NRF_DFU_BLE_ADV_NAME="DfuTest".
// Custom-built bootloaders may use "DfuTarg" (the SDK header default) — override
// BOOTLOADER_NAME accordingly.
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

function step(msg)  { console.log(`\n▶ ${msg}`); }
function info(msg)  { console.log(`  ${msg}`); }

// ── progress widget ───────────────────────────────────────────────────────────

function drawProgress(current, total) {
  const pct = Math.max(0, Math.min(100, total ? Math.floor((current / total) * 100) : 0));
  const width = 30;
  const filled = Math.round((pct / 100) * width);
  const bar = '#'.repeat(filled) + '-'.repeat(width - filled);
  process.stdout.write(`\r  [${bar}] ${String(pct).padStart(3)}%  ${(current/1024).toFixed(1)}/${(total/1024).toFixed(1)} KB`);
}

// ── sleeping helper ─────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── BlueZ helpers ───────────────────────────────────────────────────────────

function removeBlueZ(mac) {
  try {
    execSync(`bluetoothctl remove ${mac.toUpperCase()}`, { stdio: 'ignore', timeout: 5000 });
  } catch { /* ignore */ }
}

/** Discover-on / discover-off wrapper to avoid D-Bus match-rule leaks. */
async function* discover(adapter) {
  if (!(await adapter.isDiscovering())) await adapter.startDiscovery();
  try {
    while (true) {
      yield await adapter.devices();
      // small yield to let BlueZ batch new advertisements
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

// ── connection helper ───────────────────────────────────────────────────────

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

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const zipPath = args.find((a) => !a.startsWith('--'));
  const multiImage = args.includes('--multi-image');
  if (!zipPath) {
    console.error('usage: node nordic-dfu-test.mjs [--multi-image] <path-to-package.zip>');
    process.exit(2);
  }

  const zipBuffer = readFileSync(resolve(zipPath));
  info(`ZIP package: ${zipPath} (${(zipBuffer.byteLength/1024).toFixed(1)} KB)`);

  // Structural sanity
  const pkg = new SecureDfuPackage(
    zipBuffer.buffer.slice(zipBuffer.byteOffset, zipBuffer.byteOffset + zipBuffer.byteLength)
  );
  await pkg.load(JSZip);
  const image = await pkg.getAppImage() ?? await pkg.getBaseImage();
  if (!image) throw new Error('No image found in ZIP package');
  info(`manifest type: ${image.type}, init=${image.initFile}, image=${image.imageFile}`);

  const appName = process.env.APP_NAME || 'Nordic_Buttonless';
  const bootloaderName = process.env.BOOTLOADER_NAME || 'DfuTest';
  info(`appName=${appName} bootloaderName=${bootloaderName} multiImage=${multiImage}`);

  // ── Single D-Bus/BlueZ context for the whole test ─────────────────────────
  const { bluetooth, destroy } = createBluetooth();
  try {
    const adapter = await bluetooth.defaultAdapter();
    if (!(await adapter.isPowered().catch(() => true))) {
      throw new Error('BLE adapter not powered');
    }

    // ▶ Phase 1: connect to app, trigger buttonless DFU ──────────────────────
    step('Phase 1: scanning for app device');
    let device = await findDevice(adapter, appName, 30_000);
    let mac = await device.getAddress();
    info(`found "${appName}" @ ${mac}`);

    step('Phase 1: connecting');
    let session = await buildSession(device);

    const provider = new NordicProvider();
    let needsReconnect = false;

    provider.addEventListener('progress', (e) => {
      drawProgress(e.detail.currentBytes, e.detail.totalBytes);
    });
    provider.addEventListener('log', (e) => {
      const { message, level } = e.detail;
      if (level === 'error' || level === 'info') info(`[${level}] ${message}`);
    });
    provider.addEventListener('needs-reconnect', () => { needsReconnect = true; });

    await provider.attach(session);

    if (!needsReconnect) {
      info('already in bootloader mode');
    } else {
      step('Phase 1: device rebooted into bootloader — cleaning up');
      // Clear stale BlueZ object for the old MAC
      removeBlueZ(mac);
      await sleep(3000);
    }

    // ▶ Phase 2: reconnect to bootloader ───────────────────────────────────────
    if (needsReconnect) {
      step('Phase 2: scanning for bootloader');
      device = await findDevice(adapter, bootloaderName, 30_000);
      mac = await device.getAddress();
      info(`found bootloader "${bootloaderName}" @ ${mac}`);

      step('Phase 2: connecting to bootloader');
      session = await buildSession(device);
      await provider.attach(session);
    }

    // ── Load firmware ─────────────────────────────────────────────────────────
    step('Loading firmware package');
    await provider.loadFirmware(new Uint8Array(zipBuffer));
    info('package parsed');
    if (multiImage) {
      provider.setMultiImage(true);
      info('multi-image mode enabled');
    }

    // ▶ Phase 3: first transfer (base or single) ───────────────────────────────
    step('Phase 3: running DFU transfer');
    const t0 = Date.now();
    let needsContinue;
    try {
      needsContinue = (await provider.runUpdate()).needsContinue ?? false;
    } catch (updateErr) {
      process.stdout.write('\n');
      throw updateErr;
    }

    // Nothing more to do (single-image or base-only)
    if (!needsContinue) {
      process.stdout.write('\n');
      info(`DFU complete in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      await provider.detach();
      try { await device.disconnect(); } catch { /* ignore */ }
      console.log(`\n✓ PASS — Nordic Secure DFU complete.`);
      return;
    }

    // ▶ Phase 4: base image done, bootloader in continuation mode ──────────────
    process.stdout.write('\n');
    step('Base image transferred — device rebooting into continuation mode');
    removeBlueZ(mac);
    await sleep(3000);

    // ▶ Phase 5: reconnect for application image ───────────────────────────────
    step('Phase 5: scanning for bootloader');
    device = await findDevice(adapter, bootloaderName, 30_000);
    mac = await device.getAddress();
    info(`found bootloader "${bootloaderName}" @ ${mac}`);

    step('Phase 5: connecting to bootloader');
    session = await buildSession(device);
    await provider.attach(session);

    // ▶ Phase 6: transfer application image ──────────────────────────────────
    step('Phase 6: running final DFU transfer');
    try {
      const result = await provider.runUpdate();
      if (result?.needsContinue) {
        throw new Error('Unexpected second continuation after application transfer');
      }
    } catch (updateErr) {
      process.stdout.write('\n');
      throw updateErr;
    }

    process.stdout.write('\n');
    info(`DFU complete in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    await provider.detach();
    try { await device.disconnect(); } catch { /* ignore */ }
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
