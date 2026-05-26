import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SmpProvider } from '../smp/smp-provider.js';

describe('SmpProvider transfer profile', () => {
  it('applies conservative transport settings', () => {
    const p = new SmpProvider({ mtu: 244 });
    const calls = [];
    p._mcuMgr = {
      configureTransport: (cfg) => calls.push(cfg),
      setReliableMode: () => {},
    };

    p.setTransferProfile('conservative');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].mtu, 128);
    assert.strictEqual(calls[0].reliableMode, true);
  });

  it('applies aggressive transport settings', () => {
    const p = new SmpProvider({ mtu: 244 });
    let cfg;
    p._mcuMgr = { configureTransport: (c) => { cfg = c; }, setReliableMode: () => {} };
    p.setTransferProfile('aggressive');
    assert.strictEqual(cfg.mtu, 244);
    assert.strictEqual(cfg.reliableMode, false);
  });
});
