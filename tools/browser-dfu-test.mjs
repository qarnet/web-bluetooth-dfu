#!/usr/bin/env node
// Puppeteer-based end-to-end browser DFU test.
//
// Automates Chrome to load the web app over HTTPS, connects to a BLE device via
// the native Web Bluetooth picker, and runs the full SMP DFU flow:
//   upload → test → reset → reconnect → confirm → verify.
//
// This is the browser-path complement to the headless `tools/dfu-test.mjs`.
// It exercises the actual DOM, Web Bluetooth GATT APIs, and the UI state machine.
//
// Requirements:
//   - Chrome/Chromium with Web Bluetooth support (Linux: enable
//     chrome://flags/#enable-web-bluetooth-new-permissions-backend)
//   - The HTTPS server running (`./serve.py` in another terminal)
//   - A BLE device advertising as the expected name (default "Zephyr")
//   - Node.js 18+ with puppeteer installed in tools/ (npm install in tools/)
//
// Usage:
//   node browser-dfu-test.mjs <path-to-zephyr.signed.bin>
//
// Environment:
//   APP_URL          — app URL (default https://localhost:8443)
//   DEVICE_NAME      — advertised BLE name (default "Zephyr")
//   PUPPETEER_CHROME — path to Chrome binary (default: puppeteer bundled Chrome)
//   HEADLESS         — "1" to run headless (default: visible window)
//   TIMEOUT_MS       — global test timeout (default 300000 = 5 min)
//
// Exit: 0 = upgraded + confirmed, 1 = failure, 2 = bad usage.

import puppeteer from 'puppeteer';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const APP_URL     = process.env.APP_URL     || 'https://localhost:8443';
const DEVICE_NAME = process.env.DEVICE_NAME || 'Zephyr';
const HEADLESS    = process.env.HEADLESS    === '1';
const TIMEOUT_MS  = parseInt(process.env.TIMEOUT_MS, 10) || 300_000;
const CHROME_BIN  = process.env.PUPPETEER_CHROME || undefined;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function step(msg)  { console.log(`\n▶ ${msg}`); }
function info(msg)  { console.log(`  ${msg}`); }
function pass(msg)  { console.log(`\n✓ ${msg}`); }
function fail(msg)  { console.error(`\n✗ ${msg}`); }

/** Parse MCUboot version from image header bytes. */
function mcubootVersion(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return `${dv.getUint8(20)}.${dv.getUint8(21)}.${dv.getUint16(22, true)}`;
}

/** Launch Chrome with the right flags for Web Bluetooth. */
async function launchBrowser() {
  const args = [
    '--enable-features=WebBluetooth',
    // Disable first-run UI, password saving, etc. to keep the test clean.
    '--no-first-run',
    '--disable-default-apps',
    '--disable-popup-blocking',
    '--disable-infobars',
    '--disable-extensions',
    '--disable-blink-features=AutomationControlled',
  ];

  // On Linux, the new permissions backend must be enabled for Web Bluetooth.
  // If the user has not set the flag globally, we can't force it per-launch,
  // but we print a reminder on failure.

  return puppeteer.launch({
    headless: HEADLESS ? 'new' : false,
    executablePath: CHROME_BIN,
    args,
    ignoreHTTPSErrors: true,
    defaultViewport: HEADLESS ? { width: 1280, height: 900 } : null,
  });
}

/** Wait until an element matches a predicate evaluated in the page. */
async function waitForPredicate(page, fn, opts = {}) {
  const timeout = opts.timeout || 30_000;
  const label   = opts.label || 'predicate';
  try {
    return await page.waitForFunction(fn, { timeout, polling: opts.polling || 'raf' });
  } catch (err) {
    throw new Error(`Timeout waiting for ${label} (${timeout}ms): ${err.message}`);
  }
}

/** Read the version shown in slot 0 from the DOM. */
async function readSlot0Version(page) {
  return page.evaluate(() => {
    const slot = document.querySelector('.slot');
    if (!slot) return null;
    const versionEl = slot.querySelector('.slot-version');
    return versionEl?.textContent?.trim() || null;
  });
}

/** Check whether the confirm button is visible. */
async function isConfirmVisible(page) {
  return page.evaluate(() => {
    const el = document.getElementById('btn-confirm');
    return el && el.style.display !== 'none';
  });
}

/** Main test flow. */
async function main() {
  const binPath = process.argv[2];
  if (!binPath) {
    console.error('usage: node browser-dfu-test.mjs <path-to-zephyr.signed.bin>');
    process.exit(2);
  }

  const fw = new Uint8Array(readFileSync(resolve(binPath)));
  const expectedVersion = mcubootVersion(fw);
  info(`Firmware: ${binPath} (${(fw.byteLength / 1024).toFixed(1)} KB, version ${expectedVersion})`);
  info(`App URL:  ${APP_URL}`);
  info(`Device:   "${DEVICE_NAME}"`);
  info(`Chrome:   ${CHROME_BIN || 'puppeteer bundled'}`);
  info(`Headless: ${HEADLESS}`);

  const browser = await launchBrowser();
  const context = await browser.createBrowserContext();
  const page    = await context.newPage();

  try {
    // ── 1. Load the app ────────────────────────────────────────────────────────
    step('Loading app in Chrome');
    await page.goto(APP_URL, { waitUntil: 'networkidle0', timeout: 15_000 });
    info('page loaded');

    // Check for Web Bluetooth availability banner (if shown, the test can't proceed)
    const bannerVisible = await page.evaluate(() => {
      const b = document.getElementById('compat-banner');
      return b && b.style.display !== 'none';
    });
    if (bannerVisible) {
      const msg = await page.evaluate(() => document.getElementById('compat-msg')?.textContent || '');
      throw new Error(`Web Bluetooth unavailable in this Chrome profile: ${msg}`);
    }

    // ── 2. Upload firmware file ──────────────────────────────────────────────
    step('Uploading firmware file');
    await page.setInputFiles('#file-input', resolve(binPath));

    // Wait for protocol badge to appear (file parsed)
    await waitForPredicate(
      page,
      () => {
        const badge = document.getElementById('protocol-badge');
        return badge && badge.style.display !== 'none' && badge.textContent.length > 0;
      },
      { label: 'protocol badge after file upload' },
    );
    const badgeText = await page.evaluate(() => document.getElementById('protocol-badge').textContent);
    info(`protocol detected: ${badgeText}`);

    // ── 3. Connect to BLE device ─────────────────────────────────────────────
    step(`Opening Bluetooth picker and selecting "${DEVICE_NAME}"`);
    const [devicePrompt] = await Promise.all([
      page.waitForDevicePrompt({ timeout: 30_000 }),
      page.click('#btn-connect'),
    ]);
    info('device chooser appeared');

    const bluetoothDevice = await devicePrompt.waitForDevice(
      (d) => d.name === DEVICE_NAME,
      { timeout: 25_000 },
    );
    info(`found device: ${bluetoothDevice.name} (${bluetoothDevice.id})`);

    await devicePrompt.select(bluetoothDevice);
    info('device selected');

    // Wait for UI to show connected state
    await waitForPredicate(
      page,
      () => document.getElementById('btn-row-connected').style.display !== 'none',
      { label: 'connected state' },
    );
    info('connected');

    // Wait for slots to populate
    await waitForPredicate(
      page,
      () => document.querySelectorAll('.slot').length > 0,
      { label: 'slot list populated' },
    );
    const beforeVersion = await readSlot0Version(page);
    info(`slot 0 version before update: ${beforeVersion}`);

    // ── 4. Start DFU update ──────────────────────────────────────────────────
    step('Starting firmware update');
    await page.click('#btn-dfu');

    // Wait until the update either completes (button says "Done") or
    // the device reboots and the reconnect button appears.
    await waitForPredicate(
      page,
      () => {
        const btnDfu = document.getElementById('btn-dfu');
        const btnReconnect = document.getElementById('btn-reconnect');
        return (
          (btnDfu && btnDfu.textContent.includes('Done')) ||
          (btnReconnect && btnReconnect.style.display !== 'none')
        );
      },
      { label: 'update completion or reconnect request', timeout: 180_000 },
    );

    const needsReconnect = await page.evaluate(() => {
      const el = document.getElementById('btn-reconnect');
      return el && el.style.display !== 'none';
    });

    if (!needsReconnect) {
      // Update finished without a reboot (unlikely for SMP, but handle it)
      info('update finished without reconnect');
    } else {
      // ── 5. Reconnect after device reboot ───────────────────────────────────
      step('Device rebooted — reconnecting');
      await sleep(5000); // give the device time to boot and start advertising

      const [devicePrompt2] = await Promise.all([
        page.waitForDevicePrompt({ timeout: 30_000 }),
        page.click('#btn-reconnect'),
      ]);
      info('device chooser appeared for reconnect');

      const bluetoothDevice2 = await devicePrompt2.waitForDevice(
        (d) => d.name === DEVICE_NAME,
        { timeout: 25_000 },
      );
      info(`found device: ${bluetoothDevice2.name}`);

      await devicePrompt2.select(bluetoothDevice2);

      await waitForPredicate(
        page,
        () => document.getElementById('btn-row-connected').style.display !== 'none',
        { label: 'reconnected state' },
      );
      info('reconnected');

      // Wait for confirm button to appear (slot 0 active + pending)
      await waitForPredicate(
        page,
        () => {
          const el = document.getElementById('btn-confirm');
          return el && el.style.display !== 'none';
        },
        { label: 'confirm button visible' },
      );
      info('confirm button visible — new image is active but pending');

      // ── 6. Confirm the update ──────────────────────────────────────────────
      step('Confirming image (making swap permanent)');
      await page.click('#btn-confirm');

      await waitForPredicate(
        page,
        () => {
          const el = document.getElementById('btn-confirm');
          return el && el.textContent.includes('Confirmed');
        },
        { label: 'confirm complete' },
      );
      info('image confirmed');
    }

    // ── 7. Verify final slot state ───────────────────────────────────────────
    step('Verifying final slot state');
    await page.click('#btn-refresh');

    await waitForPredicate(
      page,
      () => document.querySelectorAll('.slot').length > 0,
      { label: 'slots refreshed after confirm' },
    );

    const finalVersion = await readSlot0Version(page);
    const isConfirmed = await page.evaluate(() => {
      const slot = document.querySelector('.slot');
      if (!slot) return false;
      const badges = slot.querySelector('.badges')?.textContent || '';
      return badges.includes('confirmed');
    });

    info(`slot 0 version after update: ${finalVersion}`);
    info(`slot 0 confirmed: ${isConfirmed}`);

    if (finalVersion !== expectedVersion) {
      throw new Error(`Version mismatch: expected ${expectedVersion}, got ${finalVersion}`);
    }
    if (!isConfirmed) {
      throw new Error('Slot 0 is not confirmed after DFU');
    }

    pass(`Device upgraded to ${finalVersion} and confirmed.`);
  } catch (err) {
    // If Web Bluetooth failed, remind about the Linux flag.
    if (err.message.includes('Web Bluetooth unavailable')) {
      info('TIP: On Linux, enable chrome://flags/#enable-web-bluetooth-new-permissions-backend');
    }
    fail(err.message);
    // Try to capture a screenshot for debugging
    try {
      const ssPath = resolve('browser-test-failure.png');
      await page.screenshot({ path: ssPath, fullPage: true });
      info(`screenshot saved: ${ssPath}`);
    } catch { /* ignore screenshot failure */ }
    process.exit(1);
  } finally {
    await browser.close();
  }
}

// Global timeout guard
const timer = setTimeout(() => {
  fail(`Test timed out after ${TIMEOUT_MS}ms`);
  process.exit(1);
}, TIMEOUT_MS);

main()
  .then(() => {
    clearTimeout(timer);
    process.exit(0);
  })
  .catch((err) => {
    clearTimeout(timer);
    fail(err.message);
    process.exit(1);
  });
