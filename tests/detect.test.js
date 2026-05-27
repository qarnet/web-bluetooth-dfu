import { describe, it } from 'node:test';
import assert from 'node:assert';
import { detectFromFile, detectFromDevice, resolveProtocol } from '../core/detect.js';

describe('detect', () => {
  describe('detectFromFile', () => {
    it('should detect SMP from MCUboot magic', () => {
      // 0x96f3b83d in little-endian: 3d b8 f3 96
      const data = new Uint8Array([0x3d, 0xb8, 0xf3, 0x96, 0x00, 0x00]);
      assert.strictEqual(detectFromFile(data), 'smp');
    });

    it('should detect Nordic from ZIP magic', () => {
      // PK\x03\x04
      const data = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
      assert.strictEqual(detectFromFile(data), 'nordic');
    });

    it('should return null for unknown data', () => {
      const data = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
      assert.strictEqual(detectFromFile(data), null);
    });

    it('should return null for short data', () => {
      assert.strictEqual(detectFromFile(new Uint8Array([0x00])), null);
    });
  });

  describe('detectFromDevice', () => {
    it('should detect SMP service', () => {
      const services = new Map([
        ['8d53dc1d-1db7-4cd3-868b-8a527460aa84', { characteristics: new Map() }],
      ]);
      assert.strictEqual(detectFromDevice(services), 'smp');
    });

    it('should detect Nordic bootloader', () => {
      const services = new Map([
        [
          '0000fe59-0000-1000-8000-00805f9b34fb',
          {
            characteristics: new Map([
              ['8ec90001-f315-4f60-9fb8-838830daea50', {}],
              ['8ec90002-f315-4f60-9fb8-838830daea50', {}],
            ]),
          },
        ],
      ]);
      assert.strictEqual(detectFromDevice(services), 'nordic');
    });

    it('should detect Nordic buttonless', () => {
      const services = new Map([
        [
          '0000fe59-0000-1000-8000-00805f9b34fb',
          {
            characteristics: new Map([['8ec90003-f315-4f60-9fb8-838830daea50', {}]]),
          },
        ],
      ]);
      assert.strictEqual(detectFromDevice(services), 'nordic-buttonless');
    });

    it('should return legacy for legacy DFU service', () => {
      const services = new Map([
        ['00001530-1212-efde-1523-785feabcd123', { characteristics: new Map() }],
      ]);
      assert.strictEqual(detectFromDevice(services), 'legacy');
    });

    it('should return null for unknown services', () => {
      assert.strictEqual(detectFromDevice(new Map()), null);
    });
  });

  describe('resolveProtocol', () => {
    it('should use device signal when both match', () => {
      assert.strictEqual(resolveProtocol('smp', 'smp'), 'smp');
    });

    it('should use device signal when file signal is null', () => {
      assert.strictEqual(resolveProtocol(null, 'nordic'), 'nordic');
    });

    it('should use file signal when device signal is null', () => {
      assert.strictEqual(resolveProtocol('smp', null), 'smp');
    });

    it('should throw on mismatch', () => {
      assert.throws(
        () => resolveProtocol('smp', 'nordic'),
        /Device expects NORDIC but the selected file is SMP/
      );
    });

    it('should resolve nordic-buttonless to nordic', () => {
      assert.strictEqual(resolveProtocol('nordic', 'nordic-buttonless'), 'nordic');
    });

    it('should throw on legacy', () => {
      assert.throws(() => resolveProtocol(null, 'legacy'), /Legacy DFU/);
    });
  });
});
