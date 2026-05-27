import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  loadFilterConfig,
  saveFilterConfig,
  isValidUuid,
  normalizeUuid,
} from '../core/filter-store.js';

// Mock localStorage
global.localStorage = {
  _data: {},
  getItem(key) {
    return this._data[key] || null;
  },
  setItem(key, val) {
    this._data[key] = val;
  },
  removeItem(key) {
    delete this._data[key];
  },
  clear() {
    this._data = {};
  },
};

describe('filter-store', () => {
  it('should return defaults when localStorage is empty', () => {
    localStorage.clear();
    const cfg = loadFilterConfig();
    assert.strictEqual(cfg.scanAll, true);
    assert.strictEqual(cfg.namePrefix, '');
    assert.strictEqual(cfg.serviceUuid, '');
  });

  it('should persist and restore config', () => {
    localStorage.clear();
    saveFilterConfig({
      scanAll: false,
      namePrefix: 'Zephyr',
      serviceUuid: '8d53dc1d-1db7-4cd3-868b-8a527460aa84',
    });
    const cfg = loadFilterConfig();
    assert.strictEqual(cfg.scanAll, false);
    assert.strictEqual(cfg.namePrefix, 'Zephyr');
    assert.strictEqual(cfg.serviceUuid, '8d53dc1d-1db7-4cd3-868b-8a527460aa84');
  });

  it('should validate correct UUIDs', () => {
    assert.strictEqual(isValidUuid('8d53dc1d-1db7-4cd3-868b-8a527460aa84'), true);
    assert.strictEqual(isValidUuid('0000fe59-0000-1000-8000-00805f9b34fb'), true);
  });

  it('should reject invalid UUIDs', () => {
    assert.strictEqual(isValidUuid('not-a-uuid'), false);
    assert.strictEqual(isValidUuid('8d53dc1d-1db7-4cd3'), false);
    assert.strictEqual(isValidUuid(''), false);
    assert.strictEqual(isValidUuid(null), false);
  });

  it('should normalize 4-char short UUIDs to 128-bit', () => {
    assert.strictEqual(normalizeUuid('fe59'), '0000fe59-0000-1000-8000-00805f9b34fb');
  });

  it('should normalize full UUIDs to lowercase', () => {
    assert.strictEqual(
      normalizeUuid('8D53DC1D-1DB7-4CD3-868B-8A527460AA84'),
      '8d53dc1d-1db7-4cd3-868b-8a527460aa84'
    );
  });

  it('should handle empty strings gracefully', () => {
    assert.strictEqual(normalizeUuid(''), '');
    assert.strictEqual(normalizeUuid(null), '');
  });
});
