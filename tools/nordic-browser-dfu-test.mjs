#!/usr/bin/env node
// Puppeteer-based end-to-end browser test for Nordic Secure DFU.
//
// Automates Chrome to load the web app, connect to a Nordic Secure DFU device,
// and run the full DFU flow: init packet transfer → firmware transfer → reboot.
//
// Usage:
//   node nordic-browser-dfu-test.mjs <path-to-package.zip>
//
// Environment:
//   APP_URL          — app URL (default https://localhost:8443)
//   DEVICE_NAME      — advertised BLE name in application mode (default "DfuTarg")
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
const DEVICE_NAME     = process.env.DEVICE_NAME     || 'DfuTarg';
const BOOTLOADER_NAME = process.env.BOOTLOADER_NAME || 'DfuTest';
const HEADLESS        = process.env.HEADLESS        === '1';
const TIMEOUT_MS      = parseInt(process.env.TIMEOUT_MS, 10) || 300_000;
const CHROME_BIN      = process.env.PUPPETEER_CHROME || undefined;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function step(msg)  { console.log(`\n▶ ${msg}`); }
function info(msg)  { console.log(`  ${msg}`); }
function pass(msg)  { console.log(`\n✓ ${msg}`); }
function fail(msg)  { console.error(`\n✗ ${msg}`); }

/** Launch Chrome with the right flags for Web Bluetooth. */
async function launchBrowser() {
  const args = [
    '--enable-features=WebBluetooth',
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

/** Main test flow. */
async function main() {
  const zipPath = process.argv[2];
  if (!zipPath) {
    console.error('usage: node nordic-browser-dfu-test.mjs <path-to-package.zip>');
    process.exit(2);
  }

  const zipSize = readFileSync(resolve(zipPath)).byteLength;
  info(`ZIP package: ${zipPath} (${(zipSize / 1024).toFixed(1)} KB)`);
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

    const bannerVisible = await page.evaluate(() => {
      const b = document.getElementById('compat-banner');
      return b && b.style.display !== 'none';
    });
    if (bannerVisible) {
      const msg = await page.evaluate(() => document.getElementById('compat-msg')?.textContent || '');
      throw new Error(`Web Bluetooth unavailable: ${msg}`);
    }

    // ── 2. Upload package ──────────────────────────────────────────────────────
    step('Uploading DFU package');
    await page.setInputFiles('#file-input', resolve(zipPath));

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
    await page.click('#btn-dfu');

    // Wait until the update either completes or the reconnect button appears
    // (buttonless flow reboots into bootloader and asks for reconnect)
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
      { label: 'transfer completion or reconnect request', timeout: 180_000 },
    );

    const needsReconnect = await page.evaluate(() => {
      const el = document.getElementById('btn-reconnect');
      return el && el.style.display !== 'none';
    });

    if (needsReconnect) {
      // Buttonless flow: device rebooted into bootloader
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

      // Continue transfer
      await waitForPredicate(
        page,
        () => {
          const btnDfu = document.getElementById('btn-dfu');
          return btnDfu && btnDfu.textContent.includes('Done');
        },
        { label: 'transfer complete after bootloader reconnect', timeout: 180_000 },
      );
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
