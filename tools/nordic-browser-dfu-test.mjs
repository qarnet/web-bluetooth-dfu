#!/usr/bin/env node
// Puppeteer-based end-to-end browser test for Nordic Secure DFU.
//
// Automates Chrome to load the web app, connect to a Nordic Secure DFU device,
// and run the full DFU flow: init packet transfer → firmware transfer → reboot.
//
// Supports both single-image and multi-image DFU packages.
//
// Usage:
//   node nordic-browser-dfu-test.mjs [--multi-image] <path-to-package.zip>
//
// Environment:
//   APP_URL          — app URL (default https://localhost:8443)
//   DEVICE_NAME      — advertised BLE name in application mode (default "Nordic_Buttonless")
//   BOOTLOADER_NAME  — name after buttonless reboot (default "DfuTest")
//   PUPPETEER_CHROME — path to Chrome binary
//   HEADLESS         — "1" to run headless
//   TIMEOUT_MS       — global test timeout (default 300000)
//
// Exit: 0 = transfer complete, 1 = failure, 2 = bad usage.

import puppeteer from 'puppeteer';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const APP_URL         = process.env.APP_URL         || 'https://localhost:8443';
const DEVICE_NAME     = process.env.DEVICE_NAME     || 'Nordic_Buttonless';
const BOOTLOADER_NAME = process.env.BOOTLOADER_NAME || 'DfuTest';
const HEADLESS        = process.env.HEADLESS        === '1';
const TIMEOUT_MS      = parseInt(process.env.TIMEOUT_MS, 10) || 300_000;
const CHROME_BIN      = process.env.PUPPETEER_CHROME || undefined;

const args = process.argv.slice(2);
const MULTI_IMAGE = args.includes('--multi-image');
const zipArg = args.find((a) => !a.startsWith('--'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function step(msg)  { console.log(`\n▶ ${msg}`); }
function info(msg)  { console.log(`  ${msg}`); }
function pass(msg)  { console.log(`\n✓ ${msg}`); }
function fail(msg)  { console.error(`\n✗ ${msg}`); }

/** Launch Chrome with the right flags for Web Bluetooth. */
async function launchBrowser() {
  const args = [
    '--enable-features=WebBluetooth,WebBluetoothNewPermissionsBackend',
    '--ignore-certificate-errors',
    '--no-first-run',
    '--disable-default-apps',
    '--disable-popup-blocking',
    '--disable-infobars',
    '--disable-extensions',
    '--disable-blink-features=AutomationControlled',
  ];
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

/** Detect whether the UI shows an auto-reconnect succeeded. */
async function isAutoReconnected(page) {
  return page.evaluate(() => {
    const btnReconnect = document.getElementById('btn-reconnect');
    const btnRowConnected = document.getElementById('btn-row-connected');
    return (
      btnReconnect && btnReconnect.style.display === 'none' &&
      btnRowConnected && btnRowConnected.style.display !== 'none'
    );
  });
}

/** Wait for DFU to complete or a reconnect signal. */
async function waitForDfuOrReconnect(page, label, timeout = 180_000) {
  await waitForPredicate(
    page,
    () => {
      const btnDfu = document.getElementById('btn-dfu');
      const btnReconnect = document.getElementById('btn-reconnect');
      const btnRowConnected = document.getElementById('btn-row-connected');
      return (
        (btnDfu && btnDfu.textContent.includes('Done')) ||
        (btnReconnect && btnReconnect.style.display !== 'none') ||
        (btnRowConnected && btnRowConnected.style.display !== 'none')
      );
    },
    { label, timeout },
  );
}

/** Main test flow. */
async function main() {
  if (!zipArg) {
    console.error('usage: node nordic-browser-dfu-test.mjs [--multi-image] <path-to-package.zip>');
    process.exit(2);
  }

  const zipSize = readFileSync(resolve(zipArg)).byteLength;
  info(`ZIP package: ${zipArg} (${(zipSize / 1024).toFixed(1)} KB)`);
  info(`Multi-image: ${MULTI_IMAGE}`);
  info(`App URL:     ${APP_URL}`);
  info(`Device:      "${DEVICE_NAME}" (bootloader: "${BOOTLOADER_NAME}")`);
  info(`Chrome:      ${CHROME_BIN || 'puppeteer bundled'}`);
  info(`Headless:    ${HEADLESS}`);

  const browser = await launchBrowser();
  const context = await browser.createBrowserContext();
  const page    = await context.newPage();

  try {
    // ── 1. Load the app ────────────────────────────────────────────────────────
    step('Loading app in Chrome');
    await page.goto(APP_URL, { waitUntil: 'networkidle0', timeout: 15_000 });
    info('page loaded');

    await sleep(500);

    const bannerVisible = await page.evaluate(() => {
      const b = document.getElementById('compat-banner');
      return !!b && getComputedStyle(b).display !== 'none';
    });
    if (bannerVisible) {
      const msg = await page.evaluate(() => document.getElementById('compat-msg')?.textContent || '');
      throw new Error(`Web Bluetooth unavailable: ${msg}`);
    }

    // ── 2. Upload package ──────────────────────────────────────────────────────
    step('Uploading DFU package');
    const fileInput = await page.$('#file-input');
    await fileInput.uploadFile(resolve(zipArg));

    await waitForPredicate(
      page,
      () => {
        const badge = document.getElementById('protocol-badge');
        return badge && badge.style.display !== 'none' && badge.textContent.length > 0;
      },
      { label: 'protocol badge after upload' },
    );
    const badgeText = await page.evaluate(() => document.getElementById('protocol-badge').textContent);
    info(`protocol detected: ${badgeText}`);

    // ── 2b. Multi-image checkbox ─────────────────────────────────────────────
    if (MULTI_IMAGE) {
      const hasCheckbox = await page.evaluate(() => {
        const row = document.getElementById('multi-image-row');
        const cb  = document.getElementById('multi-image-check');
        return row && row.style.display !== 'none' && cb && !cb.disabled;
      });
      if (hasCheckbox) {
        step('Enabling multi-image update');
        await page.click('#multi-image-check');
        info('multi-image checkbox checked');
      } else {
        info('package does not contain multi-image — proceeding as single-image');
      }
    }

    // ── 3. Connect to device ───────────────────────────────────────────────────
    step(`Opening Bluetooth picker and selecting "${DEVICE_NAME}"`);
    const [devicePrompt] = await Promise.all([
      page.waitForDevicePrompt({ timeout: 30_000 }),
      page.click('#btn-connect'),
    ]);
    info('device chooser appeared');

    const device = await devicePrompt.waitForDevice(
      (d) => d.name === DEVICE_NAME,
      { timeout: 25_000 },
    );
    info(`found device: ${device.name}`);
    await devicePrompt.select(device);

    await waitForPredicate(
      page,
      () => document.getElementById('btn-row-connected').style.display !== 'none',
      { label: 'connected state' },
    );
    info('connected');

    // ── 4. Start DFU update ──────────────────────────────────────────────────
    step('Starting DFU transfer');
    const t0 = Date.now();

    // Click Update Firmware
    await waitForPredicate(
      page,
      () => {
        const btn = document.getElementById('btn-dfu');
        return btn && !btn.disabled;
      },
      { label: 'Update Firmware button enabled' },
    );
    await page.click('#btn-dfu');

    // Wait for completion or reconnect
    await waitForDfuOrReconnect(page, 'transfer completion or reconnect request');

    const isDone = await page.evaluate(() => {
      const btn = document.getElementById('btn-dfu');
      return btn && btn.textContent.includes('Done');
    });

    if (!isDone) {
      const autoReconnected = await isAutoReconnected(page);
      if (autoReconnected) {
        info('auto-reconnect succeeded — device is back in bootloader continuation mode');
      } else {
        // Manual reconnect needed (buttonless flow into bootloader)
        const needsReconnect = await page.evaluate(() => {
          const el = document.getElementById('btn-reconnect');
          return el && el.style.display !== 'none';
        });

        if (needsReconnect) {
          step('Device rebooted into bootloader — reconnecting');
          await sleep(5000);

          const [devicePrompt2] = await Promise.all([
            page.waitForDevicePrompt({ timeout: 30_000 }),
            page.click('#btn-reconnect'),
          ]);
          info('device chooser appeared for bootloader');

          const bootloader = await devicePrompt2.waitForDevice(
            (d) => d.name === BOOTLOADER_NAME,
            { timeout: 25_000 },
          );
          info(`found bootloader: ${bootloader.name}`);
          await devicePrompt2.select(bootloader);

          await waitForPredicate(
            page,
            () => document.getElementById('btn-row-connected').style.display !== 'none',
            { label: 'reconnected to bootloader' },
          );
          info('connected to bootloader');
        }
      }

      // For multi-image: after base transfer + reboot, we need to click Update again
      // for the app image. For single-image with buttonless, the transfer may have
      // already started automatically after reconnect.
      const stillNeedsClick = await page.evaluate(() => {
        const btn = document.getElementById('btn-dfu');
        return btn && !btn.disabled && !btn.textContent.includes('Done');
      });

      if (stillNeedsClick) {
        step('Continuing DFU transfer');
        await page.click('#btn-dfu');
      }

      // Wait for final completion
      await waitForDfuOrReconnect(page, 'final transfer completion', 180_000);

      const finalDone = await page.evaluate(() => {
        const btn = document.getElementById('btn-dfu');
        return btn && btn.textContent.includes('Done');
      });

      if (!finalDone) {
        // Multi-image step 1 produced another reconnect — wait for auto-reconnect
        const autoReconnected2 = await isAutoReconnected(page);
        if (autoReconnected2) {
          info('auto-reconnect succeeded after second transfer');
        } else {
          throw new Error('Transfer did not complete — unexpected state after reboot');
        }
      }
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    info(`transfer complete in ${elapsed}s`);

    pass(`Nordic Secure DFU complete in ${elapsed}s.`);
  } catch (err) {
    fail(err.message);
    try {
      const ssPath = resolve('nordic-browser-test-failure.png');
      await page.screenshot({ path: ssPath, fullPage: true });
      info(`screenshot saved: ${ssPath}`);
    } catch { /* ignore */ }
    process.exit(1);
  } finally {
    await browser.close();
  }
}

const timer = setTimeout(() => {
  fail(`Test timed out after ${TIMEOUT_MS}ms`);
  process.exit(1);
}, TIMEOUT_MS);

main()
  .then(() => { clearTimeout(timer); process.exit(0); })
  .catch((err) => { clearTimeout(timer); fail(err.message); process.exit(1); });
