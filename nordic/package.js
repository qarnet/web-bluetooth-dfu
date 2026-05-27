/** Ported from web-bluetooth-dfu examples/package.js to vanilla JS ESM.
 * Source reference: https://github.com/thegecko/web-bluetooth-dfu (MIT License).
 * Requires vendor/jszip.mjs for ZIP parsing.
 */

export class SecureDfuPackage {
  constructor(buffer) {
    this.buffer = buffer;
    this.zipFile = null;
    this.manifest = null;
  }

  async load(JSZip) {
    this.zipFile = await JSZip.loadAsync(this.buffer);
    const manifestEntry = this.zipFile.file('manifest.json');
    if (!manifestEntry) throw new Error('Unable to find manifest, is this a proper DFU package?');
    const content = await manifestEntry.async('string');
    this.manifest = JSON.parse(content).manifest;
    return this;
  }

  async getImage(types) {
    for (const type of types) {
      if (this.manifest[type]) {
        const entry = this.manifest[type];
        const result = { type, initFile: entry.dat_file, imageFile: entry.bin_file };
        result.initData = await this.zipFile.file(result.initFile).async('arraybuffer');
        result.imageData = await this.zipFile.file(result.imageFile).async('arraybuffer');
        return result;
      }
    }
    return null;
  }

  /** Expose manifest metadata without loading image bytes. */
  getManifestInfo() {
    const types = Object.keys(this.manifest || {});
    return {
      types,
      hasBase: types.some((t) => ['softdevice', 'bootloader', 'softdevice_bootloader'].includes(t)),
      hasApp: types.includes('application'),
    };
  }

  getBaseImage() {
    return this.getImage(['softdevice', 'bootloader', 'softdevice_bootloader']);
  }
  getAppImage() {
    return this.getImage(['application']);
  }
}
