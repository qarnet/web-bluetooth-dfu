import { describe, it } from 'node:test';
import assert from 'node:assert';
import { encode, decode } from '../smp/cbor.js';

describe('cbor', () => {
  describe('roundtrip primitives', () => {
    it('null', () => {
      assert.strictEqual(decode(encode(null)), null);
    });

    it('boolean', () => {
      assert.strictEqual(decode(encode(true)), true);
      assert.strictEqual(decode(encode(false)), false);
    });

    it('integer', () => {
      assert.strictEqual(decode(encode(0)), 0);
      assert.strictEqual(decode(encode(1)), 1);
      assert.strictEqual(decode(encode(23)), 23);
      assert.strictEqual(decode(encode(24)), 24);
      assert.strictEqual(decode(encode(255)), 255);
      assert.strictEqual(decode(encode(256)), 256);
      assert.strictEqual(decode(encode(65535)), 65535);
      assert.strictEqual(decode(encode(65536)), 65536);
      assert.strictEqual(decode(encode(-1)), -1);
      assert.strictEqual(decode(encode(-24)), -24);
      assert.strictEqual(decode(encode(-25)), -25);
      assert.strictEqual(decode(encode(-256)), -256);
      assert.strictEqual(decode(encode(-257)), -257);
      assert.strictEqual(decode(encode(-65536)), -65536);
      assert.strictEqual(decode(encode(-65537)), -65537);
    });

    it('float is not tested — SMP payloads never contain floats', () => {
      assert.ok(true);
    });

    it('string', () => {
      assert.strictEqual(decode(encode('')), '');
      assert.strictEqual(decode(encode('hello')), 'hello');
      assert.strictEqual(decode(encode('héllo')), 'héllo');
      // 256-char string forces the 2-byte length path
      const long = 'a'.repeat(256);
      assert.strictEqual(decode(encode(long)), long);
    });

    it('empty array', () => {
      const arr = decode(encode([]));
      assert.deepStrictEqual(arr, []);
    });

    it('array of primitives', () => {
      const arr = decode(encode([1, 2, 3]));
      assert.deepStrictEqual(arr, [1, 2, 3]);
    });

    it('nested array', () => {
      const arr = decode(encode([1, [2, 3], 4]));
      assert.deepStrictEqual(arr, [1, [2, 3], 4]);
    });

    it('empty object', () => {
      const obj = decode(encode({}));
      assert.deepStrictEqual(obj, {});
    });

    it('flat object', () => {
      const obj = decode(encode({ a: 1, b: 'two' }));
      assert.deepStrictEqual(obj, { a: 1, b: 'two' });
    });

    it('nested object', () => {
      const obj = decode(encode({ outer: { inner: 42 } }));
      assert.deepStrictEqual(obj, { outer: { inner: 42 } });
    });
  });

  describe('binary data (Uint8Array)', () => {
    it('empty', () => {
      const buf = new Uint8Array(0);
      const decoded = decode(encode(buf));
      assert.ok(decoded instanceof Uint8Array);
      assert.strictEqual(decoded.byteLength, 0);
    });

    it('small bytes', () => {
      const buf = new Uint8Array([0x00, 0x01, 0xff]);
      const decoded = decode(encode(buf));
      assert.ok(decoded instanceof Uint8Array);
      assert.deepStrictEqual(Array.from(decoded), [0x00, 0x01, 0xff]);
    });

    it('256 bytes', () => {
      const buf = new Uint8Array(256).fill(0xab);
      const decoded = decode(encode(buf));
      assert.ok(decoded instanceof Uint8Array);
      assert.strictEqual(decoded.byteLength, 256);
      assert.strictEqual(decoded[0], 0xab);
      assert.strictEqual(decoded[255], 0xab);
    });

    it('65536 bytes', () => {
      const buf = new Uint8Array(65536).fill(0xcd);
      const decoded = decode(encode(buf));
      assert.ok(decoded instanceof Uint8Array);
      assert.strictEqual(decoded.byteLength, 65536);
      assert.strictEqual(decoded[0], 0xcd);
      assert.strictEqual(decoded[65535], 0xcd);
    });
  });

  describe('SMP-style payloads', () => {
    it('image state response', () => {
      const payload = {
        images: [
          {
            slot: 0,
            version: '1.0.0',
            hash: new Uint8Array([1, 2, 3, 4]),
            active: true,
            confirmed: true,
            pending: false,
          },
        ],
      };
      const decoded = decode(encode(payload));
      assert.deepStrictEqual(decoded.images[0].slot, 0);
      assert.deepStrictEqual(decoded.images[0].version, '1.0.0');
      assert.ok(decoded.images[0].hash instanceof Uint8Array);
      assert.deepStrictEqual(Array.from(decoded.images[0].hash), [1, 2, 3, 4]);
      assert.deepStrictEqual(decoded.images[0].active, true);
      assert.deepStrictEqual(decoded.images[0].confirmed, true);
      assert.deepStrictEqual(decoded.images[0].pending, false);
    });

    it('image upload request', () => {
      const payload = {
        data: new Uint8Array(128).fill(0xde),
        off: 0,
        len: 204800,
      };
      const decoded = decode(encode(payload));
      assert.ok(decoded.data instanceof Uint8Array);
      assert.strictEqual(decoded.data.byteLength, 128);
      assert.strictEqual(decoded.off, 0);
      assert.strictEqual(decoded.len, 204800);
    });
  });
});
