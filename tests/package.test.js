import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { SecureDfuPackage } from '../nordic/package.js';
import JSZip from '../vendor/jszip.mjs';

// Read a real fixture from the Nordic SDK (not committed to this repo)
const FIXTURE_ZIP =
  '/mnt/c/Users/thomas-win/Nextcloud/Development-Resources/nrf5SDK/nRF5_SDK_17.1.0_ddde560/examples/dfu/secure_dfu_test_images/ble/nrf52840/ble_app_buttonless_dfu_without_bonds_s140.zip';

describe('SecureDfuPackage', () => {
  it('should parse a real Nordic DFU package', async () => {
    const buf = readFileSync(FIXTURE_ZIP);
    const pkg = new SecureDfuPackage(buf);
    await pkg.load(JSZip);

    assert.ok(pkg.manifest, 'manifest should exist');
    assert.ok(pkg.manifest.application, 'application entry should exist');
    assert.ok(pkg.manifest.application.dat_file, 'dat_file should exist');
    assert.ok(pkg.manifest.application.bin_file, 'bin_file should exist');
  });

  it('should extract application image', async () => {
    const buf = readFileSync(FIXTURE_ZIP);
    const pkg = new SecureDfuPackage(buf);
    await pkg.load(JSZip);

    const img = await pkg.getAppImage();
    assert.ok(img, 'should return app image');
    assert.strictEqual(img.type, 'application');
    assert.ok(img.initFile, 'initFile should be set');
    assert.ok(img.imageFile, 'imageFile should be set');
    assert.ok(img.initData instanceof ArrayBuffer, 'initData should be ArrayBuffer');
    assert.ok(img.imageData instanceof ArrayBuffer, 'imageData should be ArrayBuffer');
    assert.ok(img.initData.byteLength > 0, 'initData should not be empty');
    assert.ok(img.imageData.byteLength > 0, 'imageData should not be empty');
  });

  it('should return null for base image when none exists', async () => {
    const buf = readFileSync(FIXTURE_ZIP);
    const pkg = new SecureDfuPackage(buf);
    await pkg.load(JSZip);

    const base = await pkg.getBaseImage();
    // This fixture is an application-only package
    assert.strictEqual(base, null);
  });

  it('should throw for invalid ZIP', async () => {
    const buf = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
    const pkg = new SecureDfuPackage(buf);
    await assert.rejects(pkg.load(JSZip), /zip file/i);
  });

  it('should expose manifest info for single-image', async () => {
    const buf = readFileSync(FIXTURE_ZIP);
    const pkg = new SecureDfuPackage(buf);
    await pkg.load(JSZip);
    const info = pkg.getManifestInfo();
    assert.strictEqual(info.hasApp, true);
    assert.strictEqual(info.hasBase, false);
    assert.deepStrictEqual(info.types, ['application']);
  });

  it('should expose manifest info for multi-image', async () => {
    const buf = readFileSync('tests/fixtures/multi_image_s140.zip');
    const pkg = new SecureDfuPackage(buf);
    await pkg.load(JSZip);
    const info = pkg.getManifestInfo();
    assert.strictEqual(info.hasApp, true);
    assert.strictEqual(info.hasBase, true);
    assert.ok(info.types.includes('softdevice'));
    assert.ok(info.types.includes('application'));
  });

  it('should load base and app from multi-image fixture', async () => {
    const buf = readFileSync('tests/fixtures/multi_image_s140.zip');
    const pkg = new SecureDfuPackage(buf);
    await pkg.load(JSZip);
    const base = await pkg.getBaseImage();
    const app = await pkg.getAppImage();
    assert.ok(base, 'should return base image');
    assert.strictEqual(base.type, 'softdevice');
    assert.ok(app, 'should return app image');
    assert.strictEqual(app.type, 'application');
  });
});
