import { describe, it } from 'node:test';
import assert from 'node:assert';
import { shouldDisableDfuButton } from '../ui/dfu-button-state.js';

describe('DFU button UI state', () => {
  it('disables when busy or firmware/provider missing', () => {
    assert.strictEqual(
      shouldDisableDfuButton({ isBusy: true, hasFirmware: true, hasProvider: true }),
      true
    );
    assert.strictEqual(
      shouldDisableDfuButton({ isBusy: false, hasFirmware: false, hasProvider: true }),
      true
    );
    assert.strictEqual(
      shouldDisableDfuButton({ isBusy: false, hasFirmware: true, hasProvider: false }),
      true
    );
  });

  it('disables for Nordic when row visible and both image checks are off', () => {
    assert.strictEqual(
      shouldDisableDfuButton({
        isBusy: false,
        hasFirmware: true,
        hasProvider: true,
        firmwareProtocol: 'nordic',
        nordicRowVisible: true,
        nordicBaseChecked: false,
        nordicAppChecked: false,
      }),
      true
    );
  });

  it('enables for Nordic when at least one image check is on', () => {
    assert.strictEqual(
      shouldDisableDfuButton({
        isBusy: false,
        hasFirmware: true,
        hasProvider: true,
        firmwareProtocol: 'nordic',
        nordicRowVisible: true,
        nordicBaseChecked: true,
        nordicAppChecked: false,
      }),
      false
    );
    assert.strictEqual(
      shouldDisableDfuButton({
        isBusy: false,
        hasFirmware: true,
        hasProvider: true,
        firmwareProtocol: 'nordic',
        nordicRowVisible: true,
        nordicBaseChecked: false,
        nordicAppChecked: true,
      }),
      false
    );
  });

  it('does not require Nordic image checks for non-Nordic protocol', () => {
    assert.strictEqual(
      shouldDisableDfuButton({
        isBusy: false,
        hasFirmware: true,
        hasProvider: true,
        firmwareProtocol: 'smp',
        nordicRowVisible: true,
        nordicBaseChecked: false,
        nordicAppChecked: false,
      }),
      false
    );
  });
});
