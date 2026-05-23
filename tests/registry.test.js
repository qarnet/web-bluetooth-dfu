import { describe, it } from 'node:test';
import assert from 'node:assert';
import { REGISTRY } from '../core/registry.js';

describe('registry', () => {
  it('should export SMP and Nordic registries', () => {
    assert(REGISTRY.smp);
    assert(REGISTRY.nordic);
  });

  it('should have correct SMP service UUID', () => {
    assert.strictEqual(REGISTRY.smp.serviceUuid, '8d53dc1d-1db7-4cd3-868b-8a527460aa84');
    assert.strictEqual(REGISTRY.smp.charUuid, 'da2e7828-fbce-4e01-ae9e-261174997c48');
  });

  it('should have correct Nordic service UUID', () => {
    assert.strictEqual(REGISTRY.nordic.serviceUuid, '0000fe59-0000-1000-8000-00805f9b34fb');
  });

  it('should have fileMagic for SMP', () => {
    assert.strictEqual(REGISTRY.smp.fileMagic, 0x96f3b83d);
  });

  it('should have fileExt for each protocol', () => {
    assert.strictEqual(REGISTRY.smp.fileExt, '.bin');
    assert.strictEqual(REGISTRY.nordic.fileExt, '.zip');
  });
});
