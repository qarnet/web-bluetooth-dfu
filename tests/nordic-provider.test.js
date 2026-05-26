import { describe, it } from 'node:test';
import assert from 'node:assert';
import { NordicProvider } from '../nordic/nordic-provider.js';

function makeProvider() {
  const p = new NordicProvider();
  p._dfu = {
    isReady: () => true,
    setPacketReceiptNotifications: () => {},
    probeReady: async () => ({ maxSize: 512, offset: 0, crc: 0 }),
  };
  p._baseImage = { initData: new Uint8Array([1]), imageData: new Uint8Array([2]) };
  p._appImage = { initData: new Uint8Array([3]), imageData: new Uint8Array([4]) };
  return p;
}

describe('NordicProvider image selection', () => {
  it('runs app-only when only app selected', async () => {
    const p = makeProvider();
    const labels = [];
    p._transferImage = async (_img, label) => labels.push(label);
    p.setImageSelection({ base: false, app: true });

    const result = await p.runUpdate();
    assert.deepStrictEqual(labels, ['Application']);
    assert.strictEqual(result.complete, true);
  });

  it('runs base-only when only base selected', async () => {
    const p = makeProvider();
    const labels = [];
    p._transferImage = async (_img, label) => labels.push(label);
    p.setImageSelection({ base: true, app: false });

    const result = await p.runUpdate();
    assert.deepStrictEqual(labels, ['Base firmware (SoftDevice/Bootloader)']);
    assert.strictEqual(result.complete, true);
  });

  it('requests continuation when base+app selected and base done', async () => {
    const p = makeProvider();
    const labels = [];
    p._transferImage = async (_img, label) => labels.push(label);
    p.setImageSelection({ base: true, app: true });

    const result = await p.runUpdate();
    assert.deepStrictEqual(labels, ['Base firmware (SoftDevice/Bootloader)']);
    assert.strictEqual(result.needsContinue, true);
  });

  it('throws when neither image is selected', async () => {
    const p = makeProvider();
    p.setImageSelection({ base: false, app: false });
    await assert.rejects(() => p.runUpdate(), /No Nordic image selected/);
  });
});
