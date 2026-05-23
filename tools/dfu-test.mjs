#!/usr/bin/env node
// Headless BLE SMP DFU test harness — the automated "D" step (rewritten for SmpProvider).
//
// Connects to the device over real BLE (node-ble / BlueZ) and runs the full
// DFU sequence by reusing the new SmpProvider + MCUManager.
// Only the transport differs — a node-ble characteristic wrapped to look like a
// Web Bluetooth one (ble-characteristic.mjs).
//
// Usage:  node dfu-test.mjs <path-to-zephyr.signed.bin>
// Env:    DEVICE_NAME (default "Zephyr"), DEVICE_MAC (skip the name scan)
// Exit:   0 = device upgraded + confirmed, 1 = failure, 2 = bad usage.

import { webcrypto } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createBluetooth } from 'node-ble';

import { SmpProvider } from '../smp/smp-provider.js';
import { SMP_SERVICE_UUID, SMP_CHAR_UUID } from '../bluetooth/connect.js';
import { BleCharacteristic } from './ble-characteristic.mjs';

// smp/mcumgr.js calls crypto.subtle.digest — guarantee the global on Node 18.
globalThis.crypto ??= webcrypto;

// node-ble adds a D-Bus listener per discovered device — lift the default cap.
EventEmitter.defaultMaxListeners = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function step(msg)  { console.log(`\n▶ ${msg}`); }
function info(msg)  { console.log(`  ${msg}`); }

/** Parse the version out of an MCUboot image header. */
function mcubootVersion(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return `${dv.getUint8(20)}.${dv.getUint8(21)}.${dv.getUint16(22, true)}`;
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

async function openSession(device) {
  await connectWithRetry(device);
  const gatt           = await device.gatt();
  const service        = await gatt.getPrimaryService(SMP_SERVICE_UUID);
  const characteristic = await service.getCharacteristic(SMP_CHAR_UUID);

  // Build the service map that the provider expects
  const charMap = new Map();
  charMap.set(SMP_CHAR_UUID, new BleCharacteristic(characteristic, SMP_CHAR_UUID));

  const services = new Map();
  services.set(SMP_SERVICE_UUID, { service, characteristics: charMap });

  return { device, server: gatt, services, disconnect: () => device.disconnect() };
}

async function main() {
  const binPath = process.argv[2];
  if (!binPath) {
    console.error('usage: node dfu-test.mjs <path-to-zephyr.signed.bin>');
    process.exit(2);
  }

  const fw = new Uint8Array(readFileSync(resolve(binPath)));
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
    let session = await openSession(device);

    const provider = new SmpProvider({ mtu: 244 });
    provider.addEventListener('progress', (e) => {
      const { currentBytes, totalBytes } = e.detail;
      drawProgress(currentBytes, totalBytes);
    });
    provider.addEventListener('log', (e) => {
      // silently suppress logs during progress to avoid trashing the bar
    });
    await provider.attach(session);

    step('Reading image slots');
    let slots = await provider.readState();
    printSlots(slots);
    const before = slots.find((s) => s.slot === 0);
    if (!before) throw new Error('device reported no slot 0');
    info(`baseline: slot 0 version ${before.version}, hash ${before.hash.slice(0, 16)}…`);

    await provider.loadFirmware(fw);

    step(`Uploading firmware → ${expected}`);
    const t0 = Date.now();
    const result = await provider.runUpdate();
    process.stdout.write('\n');
    info(`upload+test+reset complete in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    await provider.detach();
    await device.disconnect().catch(() => {});

    step('Waiting for reboot, then reconnecting');
    await sleep(6000);
    device = await findDevice(adapter, { name: deviceName, mac });
    session = await openSession(device);
    await provider.attach(session);

    step('Verifying swapped image');
    slots = await provider.readState();
    printSlots(slots);
    const after = slots.find((s) => s.slot === 0);
    if (!after) throw new Error('no slot 0 after reboot');
    if (!after.active) throw new Error('slot 0 not active after reboot');
    info(`slot 0 now runs the uploaded image (version ${after.version}, active)`);

    step('Confirming image (make the swap permanent)');
    await provider.confirm();
    slots = await provider.readState();
    printSlots(slots);
    const final = slots.find((s) => s.slot === 0);
    if (!final?.confirmed) throw new Error('slot 0 not confirmed after confirm command');

    await provider.detach();
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
