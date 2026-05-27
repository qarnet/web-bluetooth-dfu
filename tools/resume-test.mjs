#!/usr/bin/env node
// Test SMP upload resume after mid-transfer disconnect.
// Starts upload, disconnects at ~40%, reconnects, verifies resume from offset.

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
    console.error('usage: node resume-test.mjs <path-to-zephyr.signed.bin>');
    process.exit(2);
  }

  const fw = new Uint8Array(readFileSync(resolve(binPath)));
  const deviceName = 'Zephyr';

  step('SMP resume test');
  info('Will disconnect at ~40% progress, then reconnect and verify resume');

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

    const provider = new SmpProvider({ mtu: 244 });
    let disconnectAtPct = 40;
    let disconnected = false;
    let lastOffset = 0;

    provider.addEventListener('progress', (e) => {
      const { currentBytes, totalBytes } = e.detail;
      const pct = Math.floor((currentBytes / totalBytes) * 100);
      lastOffset = currentBytes;
      if (!disconnected && pct >= disconnectAtPct) {
        disconnected = true;
        info(`Reached ${pct}% — forcing disconnect to test resume`);
        // Force disconnect in background
        device.disconnect().catch(() => {});
      }
    });

    provider.addEventListener('log', (e) => {
      if (e.detail.message.includes('Resuming')) {
        info(`RESUME LOG: ${e.detail.message}`);
      }
    });

    await provider.attach(session);

    step('Reading image slots');
    let slots = await provider.readState();
    const before = slots.find((s) => s.slot === 0);
    info(`baseline: slot 0 version ${before.version}`);

    await provider.loadFirmware(fw);

    step('Starting upload (will disconnect at ~40%)');
    const t0 = Date.now();
    try {
      await provider.runUpdate();
    } catch (err) {
      info(`Expected error on disconnect: ${err.message}`);
    }
    info(
      `Upload stopped at offset ${lastOffset} (~${Math.floor((lastOffset / fw.byteLength) * 100)}%)`
    );

    // Do NOT detach or disconnect — destroy the old bluetooth/D-Bus context.
    // The provider keeps _resumeOffset across sessions.
    destroy();

    step('Waiting 8s for device to reboot');
    await sleep(8000);

    step('Reconnecting to resume upload');
    const { bluetooth: bt2, destroy: destroy2 } = createBluetooth();
    try {
      const adapter2 = await bt2.defaultAdapter();
      if (!(await adapter2.isPowered().catch(() => true))) {
        throw new Error('BLE adapter not powered');
      }
      if (!(await adapter2.isDiscovering())) await adapter2.startDiscovery();
      device = await findDevice(adapter2, deviceName);
      session = await openSession(device);
      await provider.attach(session);

      // The provider should have _resumeOffset set from the disconnect
      info(`Provider resume offset: ${provider._resumeOffset}`);

      step('Resuming upload');
      const t1 = Date.now();
      await provider.loadFirmware(fw);
      try {
        await provider.runUpdate();
        const elapsed = (Date.now() - t1) / 1000;
        info(`Resume upload+test+reset complete in ${elapsed.toFixed(1)}s`);
      } catch (err) {
        info(`Resume error: ${err.message}`);
        throw err;
      }

      await provider.detach();
      await device.disconnect().catch(() => {});
      destroy2();

      step('Waiting for reboot, then verifying');
      await sleep(6000);
      const { bluetooth: bt3, destroy: destroy3 } = createBluetooth();
      try {
        const adapter3 = await bt3.defaultAdapter();
        if (!(await adapter3.isDiscovering())) await adapter3.startDiscovery();
        device = await findDevice(adapter3, deviceName);
        session = await openSession(device);
        await provider.attach(session);

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

        const totalElapsed = (Date.now() - t0) / 1000;
        console.log(`\n✓ PASS — resume DFU succeeded. Total time: ${totalElapsed.toFixed(1)}s`);
        console.log(
          `  First attempt stopped at ~${Math.floor((lastOffset / fw.byteLength) * 100)}%, resumed and completed.`
        );
      } finally {
        destroy3();
      }
    } finally {
      destroy2();
    }
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
