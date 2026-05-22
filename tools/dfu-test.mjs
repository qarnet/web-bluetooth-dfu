#!/usr/bin/env node
// Headless BLE SMP DFU test harness — the automated "D" step.
//
// Connects to the device over real BLE (node-ble / BlueZ) and runs the full
// DFU sequence by reusing the app's actual modules: smp/protocol.js and
// smp/image.js are imported unchanged. Only the transport differs — a node-ble
// characteristic wrapped to look like a Web Bluetooth one (ble-characteristic.mjs).
//
// Usage:  node dfu-test.mjs <path-to-zephyr.signed.bin>
// Env:    DEVICE_NAME (default "Zephyr"), DEVICE_MAC (skip the name scan)
// Exit:   0 = device upgraded + confirmed, 1 = failure, 2 = bad usage.

import { webcrypto } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createBluetooth } from 'node-ble';

import { SmpClient } from '../smp/protocol.js';
import {
  validateImage, listImages, uploadFirmware, testImage, confirmImage, resetDevice,
} from '../smp/image.js';
import { SMP_SERVICE_UUID, SMP_CHAR_UUID } from '../bluetooth/connect.js';
import { BleCharacteristic } from './ble-characteristic.mjs';

// smp/image.js calls crypto.subtle.digest — guarantee the global on Node 18.
globalThis.crypto ??= webcrypto;

// node-ble adds a D-Bus listener per discovered device — lift the default cap.
EventEmitter.defaultMaxListeners = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function step(msg)  { console.log(`\n▶ ${msg}`); }
function info(msg)  { console.log(`  ${msg}`); }

/** Parse the version out of an MCUboot image header (matches image.js fmtVersion). */
function mcubootVersion(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const major    = dv.getUint8(20);
  const minor    = dv.getUint8(21);
  const revision = dv.getUint16(22, true);
  const build    = dv.getUint32(24, true);
  return `${major}.${minor}.${revision}+${build}`;
}

function printSlots(slots) {
  for (const s of slots) {
    const flags = [
      s.active    && 'active',
      s.pending   && 'pending',
      s.confirmed && 'confirmed',
    ].filter(Boolean).join(',') || '-';
    info(`slot ${s.slot}  ${s.version.padEnd(12)} [${flags.padEnd(20)}] ${s.hash.slice(0, 16)}…`);
  }
}

function drawProgress(offset, total) {
  const pct    = total ? Math.floor((offset / total) * 100) : 0;
  const width  = 30;
  const filled = Math.round((pct / 100) * width);
  const bar    = '#'.repeat(filled) + '-'.repeat(width - filled);
  process.stdout.write(
    `\r  [${bar}] ${String(pct).padStart(3)}%  ` +
    `${(offset / 1024).toFixed(1)}/${(total / 1024).toFixed(1)} KB`,
  );
}

/** Locate the target device by MAC (if given) or by advertised name. */
async function findDevice(adapter, { name, mac }) {
  if (!(await adapter.isDiscovering())) await adapter.startDiscovery();
  if (mac) return adapter.waitDevice(mac.toUpperCase());

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

/** Connect, resolve the SMP characteristic, return a started SmpClient. */
async function openClient(device) {
  await connectWithRetry(device);
  const gatt           = await device.gatt();
  const service        = await gatt.getPrimaryService(SMP_SERVICE_UUID);
  const characteristic = await service.getCharacteristic(SMP_CHAR_UUID);
  const client         = new SmpClient(new BleCharacteristic(characteristic));
  await client.start();
  return client;
}

async function main() {
  const binPath = process.argv[2];
  if (!binPath) {
    console.error('usage: node dfu-test.mjs <path-to-zephyr.signed.bin>');
    process.exit(2);
  }

  const fw = new Uint8Array(readFileSync(resolve(binPath)));
  validateImage(fw);                       // app's own MCUboot magic check
  const expected = mcubootVersion(fw);

  const deviceName = process.env.DEVICE_NAME || 'Zephyr';
  const deviceMac  = process.env.DEVICE_MAC  || null;

  step(`Update image: ${binPath}`);
  info(`${(fw.byteLength / 1024).toFixed(1)} KB, version ${expected}`);

  const { bluetooth, destroy } = createBluetooth();
  try {
    const adapter = await bluetooth.defaultAdapter();
    if (!(await adapter.isPowered().catch(() => true))) {
      throw new Error('BLE adapter not powered — run: bluetoothctl power on');
    }

    step('Scanning for device');
    let device = await findDevice(adapter, { name: deviceName, mac: deviceMac });
    const mac  = await device.getAddress();
    info(`found "${deviceName}" @ ${mac}`);

    step('Connecting');
    let client = await openClient(device);

    step('Reading image slots');
    let slots = await listImages(client);
    printSlots(slots);
    const before = slots.find((s) => s.slot === 0);
    if (!before) throw new Error('device reported no slot 0');
    info(`baseline: slot 0 version ${before.version}, hash ${before.hash.slice(0, 16)}…`);

    step(`Uploading firmware → ${expected}`);
    const t0 = Date.now();
    await uploadFirmware(client, fw, ({ offset, total }) => drawProgress(offset, total), 128);
    process.stdout.write('\n');
    info(`upload complete in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    step('Re-reading slots after upload');
    slots = await listImages(client);
    printSlots(slots);
    const slot1 = slots.find((s) => s.slot === 1);
    if (!slot1) throw new Error('slot 1 missing after upload');
    const uploadedHash = slot1.hash;
    if (uploadedHash === before.hash) {
      throw new Error(
        'uploaded image is identical to the running image — a swap would not ' +
        'be observable. Flash the v1 baseline first: make flash');
    }
    info(`uploaded: slot 1 version ${slot1.version}, hash ${uploadedHash.slice(0, 16)}…`);

    step('Marking new image for test');
    await testImage(client, uploadedHash);

    step('Resetting device — MCUboot will swap slots');
    await resetDevice(client);
    await client.stop().catch(() => {});
    await device.disconnect().catch(() => {});

    step('Waiting for reboot, then reconnecting');
    await sleep(6000);
    device = await findDevice(adapter, { name: deviceName, mac });
    client = await openClient(device);

    step('Verifying swapped image');
    slots = await listImages(client);
    printSlots(slots);
    const after = slots.find((s) => s.slot === 0);
    if (!after) throw new Error('no slot 0 after reboot');
    if (after.hash !== uploadedHash) {
      throw new Error(
        `swap failed — slot 0 hash ${after.hash.slice(0, 16)}… ` +
        `≠ uploaded ${uploadedHash.slice(0, 16)}…`);
    }
    if (!after.active) throw new Error('slot 0 not active after reboot');
    info(`slot 0 now runs the uploaded image (version ${after.version}, active)`);

    step('Confirming image (make the swap permanent)');
    await confirmImage(client, after.hash);
    slots = await listImages(client);
    printSlots(slots);
    const final = slots.find((s) => s.slot === 0);
    if (!final?.confirmed) throw new Error('slot 0 not confirmed after confirm command');

    await client.stop().catch(() => {});
    await device.disconnect().catch(() => {});

    console.log(`\n✓ PASS — device upgraded to ${after.version}, active + confirmed.`);
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
