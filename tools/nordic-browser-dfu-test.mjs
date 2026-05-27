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
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const APP_URL = process.env.APP_URL || 'https://localhost:8443';
const DEVICE_NAME = process.env.DEVICE_NAME || 'Nordic_Buttonless';
const BOOTLOADER_NAME = process.env.BOOTLOADER_NAME || 'DfuTest';
const HEADLESS = process.env.HEADLESS === '1';
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS, 10) || 300_000;
const CHROME_BIN = process.env.PUPPETEER_CHROME || undefined;
const NORDIC_PRN = parseInt(process.env.NORDIC_PRN || '0', 10) || 0;

const args = process.argv.slice(2);
const MULTI_IMAGE = args.includes('--multi-image');
const zipArg = args.find((a) => !a.startsWith('--'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function step(msg) {
  console.log(`\n▶ ${msg}`);
}
function info(msg) {
  console.log(`  ${msg}`);
}
function pass(msg) {
  console.log(`\n✓ ${msg}`);
}
function fail(msg) {
  console.error(`\n✗ ${msg}`);
}

async function selectDeviceFromPrompt(devicePrompt, preferredNames, fallbackLabel) {
  const names = preferredNames.filter(Boolean);
  const seen = new Set();
  try {
    const device = await devicePrompt.waitForDevice(
      (d) => {
        seen.add(d.name || '(unnamed)');
        return names.includes(d.name);
      },
      { timeout: 45_000 }
    );
    info(`found device: ${device.name || '(unnamed)'} (${device.id || 'no-id'})`);
    await devicePrompt.select(device);
    return;
  } catch {
    const advertised = [...seen].sort().join(', ') || '(none observed)';
    throw new Error(
      `No preferred ${fallbackLabel} found. Expected one of [${names.join(', ')}]. ` +
        `Observed in picker: ${advertised}`
    );
  }
}

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
  const label = opts.label || 'predicate';
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
      btnReconnect &&
      btnReconnect.style.display === 'none' &&
      btnRowConnected &&
      btnRowConnected.style.display !== 'none'
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
      return (
        (btnDfu && btnDfu.textContent.includes('Done')) ||
        (btnReconnect && btnReconnect.style.display !== 'none')
      );
    },
    { label, timeout }
  );
}

async function recoverContinuationConnection(page) {
  await waitForPredicate(
    page,
    () => {
      const btnReconnect = document.getElementById('btn-reconnect');
      const btnRowConnected = document.getElementById('btn-row-connected');
      return (
        (btnReconnect && btnReconnect.style.display !== 'none') ||
        (btnRowConnected && btnRowConnected.style.display !== 'none')
      );
    },
    { label: 'connected or reconnect state', timeout: 45_000 }
  );

  const needsReconnect = await page.evaluate(() => {
    const btnReconnect = document.getElementById('btn-reconnect');
    return !!(btnReconnect && btnReconnect.style.display !== 'none');
  });

  if (!needsReconnect) return;

  step('Manual reconnect required — selecting continuation bootloader');
  const [prompt] = await Promise.all([
    page.waitForDevicePrompt({ timeout: 30_000 }),
    page.click('#btn-reconnect'),
  ]);
  await selectDeviceFromPrompt(
    prompt,
    [BOOTLOADER_NAME, 'DfuTest', 'DfuTarg'],
    'continuation reconnect'
  );

  await waitForPredicate(
    page,
    () => document.getElementById('btn-row-connected').style.display !== 'none',
    { label: 'connected after manual continuation reconnect', timeout: 30_000 }
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
  const page = await context.newPage();

  // Capture all browser console output — critical for diagnosing DFU error notifications
  page.on('console', (msg) => {
    const text = msg.text();
    // Log everything from SecureDFU, plus errors/warnings from anywhere
    if (
      msg.type() === 'error' ||
      msg.type() === 'warning' ||
      text.includes('SecureDFU') ||
      text.includes('notify') ||
      text.includes('disconnect') ||
      text.includes('written') ||
      text.includes('Error') ||
      text.includes('execute') ||
      text.includes('0x60') ||
      text.includes('init packet') ||
      text.includes('EXECUTE') ||
      text.includes('opcode')
    ) {
      info(`[${new Date().toISOString().slice(11, 23)}][BROWSER:${msg.type()}] ${text}`);
    }
  });
  page.on('pageerror', (err) => info(`[BROWSER:pageerror] ${err.message}`));

  try {
    // ── 1. Load the app ────────────────────────────────────────────────────────
    step('Loading app in Chrome');
    await page.goto(APP_URL, { waitUntil: 'networkidle0', timeout: 15_000 });
    info('page loaded');
    if (NORDIC_PRN > 0) {
      await page.evaluate((prn) => globalThis.dfuController?.setNordicPrn?.(prn), NORDIC_PRN);
      info(`configured Nordic PRN=${NORDIC_PRN}`);
    }

    await sleep(500);

    const bannerVisible = await page.evaluate(() => {
      const b = document.getElementById('compat-banner');
      return !!b && getComputedStyle(b).display !== 'none';
    });
    if (bannerVisible) {
      const msg = await page.evaluate(
        () => document.getElementById('compat-msg')?.textContent || ''
      );
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
      { label: 'protocol badge after upload' }
    );
    const badgeText = await page.evaluate(
      () => document.getElementById('protocol-badge').textContent
    );
    info(`protocol detected: ${badgeText}`);

    // ── 2b. Multi-image selection ────────────────────────────────────────────
    if (MULTI_IMAGE) {
      const hasSelectors = await page.evaluate(() => {
        const row = document.getElementById('multi-image-row');
        const base = document.getElementById('nordic-base-check');
        const app = document.getElementById('nordic-app-check');
        return row && row.style.display !== 'none' && base && app;
      });
      if (hasSelectors) {
        step('Enabling multi-image update');
        await page.evaluate(() => {
          const base = document.getElementById('nordic-base-check');
          const app = document.getElementById('nordic-app-check');
          if (base && !base.disabled) base.checked = true;
          if (app && !app.disabled) app.checked = true;
          base?.dispatchEvent(new Event('change', { bubbles: true }));
          app?.dispatchEvent(new Event('change', { bubbles: true }));
        });
        info('base and application selections enabled');
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

    await selectDeviceFromPrompt(
      devicePrompt,
      [DEVICE_NAME, 'Nordic_Buttonless', 'Nordic_HRM'],
      'app-mode target'
    );

    // Device may go directly to connected (already in bootloader) or trigger
    // buttonless DFU and show the Reconnect button instead.
    await waitForDfuOrReconnect(page, 'post-select state (connected or reconnect prompt)', 60_000);

    const directlyConnected = await page.evaluate(
      () => document.getElementById('btn-row-connected')?.style.display !== 'none'
    );

    if (directlyConnected) {
      info('connected directly (already in bootloader mode)');
    } else {
      // Buttonless DFU triggered — wait for bootloader to advertise, then reconnect
      step('Buttonless DFU triggered — reconnecting to bootloader');
      await sleep(5000);

      const [devicePrompt1b] = await Promise.all([
        page.waitForDevicePrompt({ timeout: 30_000 }),
        page.click('#btn-reconnect'),
      ]);
      info('device chooser appeared for bootloader');

      await selectDeviceFromPrompt(
        devicePrompt1b,
        [BOOTLOADER_NAME, 'DfuTest', 'DfuTarg'],
        'bootloader target'
      );

      await waitForPredicate(
        page,
        () => document.getElementById('btn-row-connected').style.display !== 'none',
        { label: 'reconnected to bootloader', timeout: 30_000 }
      );
      info('connected to bootloader');
    }

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
      { label: 'Update Firmware button enabled' }
    );
    await page.click('#btn-dfu');

    // Wait for Done OR needs-reconnect (base image done, continuation pending)
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
      { label: 'transfer done or needs-reconnect', timeout: 180_000 }
    );

    let isDone = await page.evaluate(() => {
      const btn = document.getElementById('btn-dfu');
      return btn && btn.textContent.includes('Done');
    });

    if (!isDone) {
      // Base image transferred (multi-image) — reconnect to continuation bootloader.
      step('Base image done — reconnecting to continuation bootloader');
      await recoverContinuationConnection(page);
      info('continuation reconnect available');

      // Click Update for the application image
      step('Transferring application image');
      await waitForPredicate(
        page,
        () => {
          const btn = document.getElementById('btn-dfu');
          return btn && !btn.disabled;
        },
        { label: 'Update Firmware button re-enabled', timeout: 10_000 }
      );
      await page.click('#btn-dfu');

      // Wait for Done OR needs-reconnect (continuation crash → bank pre-erased → retry).
      await waitForDfuOrReconnect(page, 'app image transfer or crash-retry reconnect', 180_000);

      const appDone = await page.evaluate(() => {
        const btn = document.getElementById('btn-dfu');
        return btn && btn.textContent.includes('Done');
      });

      const appNeedsReconnect = await page.evaluate(() => {
        const btnReconnect = document.getElementById('btn-reconnect');
        return !!(btnReconnect && btnReconnect.style.display !== 'none');
      });

      if (!appDone && appNeedsReconnect) {
        // Continuation crash retry: bank_1 is now pre-erased, device re-advertises as DfuTest.
        // Reconnect and click Update again.
        step('Continuation crash retry — reconnecting after bank pre-erase');
        await recoverContinuationConnection(page);
        info('continuation reconnect available (crash retry)');

        await waitForPredicate(
          page,
          () => {
            const btn = document.getElementById('btn-dfu');
            return btn && !btn.disabled;
          },
          { label: 'btn-dfu re-enabled after crash retry', timeout: 30_000 }
        );
        await page.click('#btn-dfu');

        await waitForPredicate(
          page,
          () => {
            const btn = document.getElementById('btn-dfu');
            return btn && btn.textContent.includes('Done');
          },
          { label: 'app image transfer completion (crash retry)', timeout: 180_000 }
        );
      } else if (!appDone) {
        throw new Error('App transfer neither completed nor requested reconnect');
      }

      isDone = true;
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
    } catch {
      /* ignore */
    }
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
  .then(() => {
    clearTimeout(timer);
    process.exit(0);
  })
  .catch((err) => {
    clearTimeout(timer);
    fail(err.message);
    process.exit(1);
  });
