/*
 * The MIT License (MIT)
 *
 * Copyright (c) 2014-2016 Patrick Gansterer <paroga@paroga.com>
 *
 * Minimal CBOR encoder/decoder, ported from mcumgr-web to a clean ES module.
 * Handles Maps, Arrays, Uint8Arrays, strings, floats, and integers.
 */

const POW_2_32 = 4294967296;
const POW_2_53 = 9007199254740992;

export function encode(value) {
  let data = new ArrayBuffer(256);
  let dataView = new DataView(data);
  let lastLength;
  let offset = 0;

  function prepareWrite(length) {
    let newByteLength = data.byteLength;
    const requiredLength = offset + length;
    while (newByteLength < requiredLength) newByteLength <<= 1;
    if (newByteLength !== data.byteLength) {
      const oldDataView = dataView;
      data = new ArrayBuffer(newByteLength);
      dataView = new DataView(data);
      const uint32count = (offset + 3) >> 2;
      for (let i = 0; i < uint32count; ++i) {
        dataView.setUint32(i << 2, oldDataView.getUint32(i << 2));
      }
    }
    lastLength = length;
    return dataView;
  }

  function commitWrite() {
    offset += lastLength;
  }

  function writeFloat64(v) {
    commitWrite(prepareWrite(8).setFloat64(offset, v));
  }
  function writeUint8(v) {
    commitWrite(prepareWrite(1).setUint8(offset, v));
  }
  function writeUint16(v) {
    commitWrite(prepareWrite(2).setUint16(offset, v));
  }
  function writeUint32(v) {
    commitWrite(prepareWrite(4).setUint32(offset, v));
  }
  function writeUint64(v) {
    const low = v % POW_2_32;
    const high = (v - low) / POW_2_32;
    const dv = prepareWrite(8);
    dv.setUint32(offset, high);
    dv.setUint32(offset + 4, low);
    commitWrite();
  }
  function writeUint8Array(value) {
    const dv = prepareWrite(value.length);
    for (let i = 0; i < value.length; ++i) dv.setUint8(offset + i, value[i]);
    commitWrite();
  }

  function writeTypeAndLength(type, length) {
    if (length < 24) {
      writeUint8((type << 5) | length);
    } else if (length < 0x100) {
      writeUint8((type << 5) | 24);
      writeUint8(length);
    } else if (length < 0x10000) {
      writeUint8((type << 5) | 25);
      writeUint16(length);
    } else if (length < 0x100000000) {
      writeUint8((type << 5) | 26);
      writeUint32(length);
    } else {
      writeUint8((type << 5) | 27);
      writeUint64(length);
    }
  }

  function encodeItem(value) {
    if (value === false) return writeUint8(0xf4);
    if (value === true) return writeUint8(0xf5);
    if (value === null) return writeUint8(0xf6);
    if (value === undefined) return writeUint8(0xf7);

    switch (typeof value) {
      case 'number': {
        if (Math.floor(value) === value) {
          if (0 <= value && value <= POW_2_53) return writeTypeAndLength(0, value);
          if (-POW_2_53 <= value && value < 0) return writeTypeAndLength(1, -(value + 1));
        }
        writeUint8(0xfb);
        return writeFloat64(value);
      }
      case 'string': {
        const utf8data = [];
        for (let i = 0; i < value.length; ++i) {
          let charCode = value.charCodeAt(i);
          if (charCode < 0x80) {
            utf8data.push(charCode);
          } else if (charCode < 0x800) {
            utf8data.push(0xc0 | (charCode >> 6));
            utf8data.push(0x80 | (charCode & 0x3f));
          } else if (charCode < 0xd800) {
            utf8data.push(0xe0 | (charCode >> 12));
            utf8data.push(0x80 | ((charCode >> 6) & 0x3f));
            utf8data.push(0x80 | (charCode & 0x3f));
          } else {
            charCode = ((charCode & 0x3ff) << 10) | (value.charCodeAt(++i) & 0x3ff);
            charCode += 0x10000;
            utf8data.push(0xf0 | (charCode >> 18));
            utf8data.push(0x80 | ((charCode >> 12) & 0x3f));
            utf8data.push(0x80 | ((charCode >> 6) & 0x3f));
            utf8data.push(0x80 | (charCode & 0x3f));
          }
        }
        writeTypeAndLength(3, utf8data.length);
        return writeUint8Array(utf8data);
      }
      default: {
        if (Array.isArray(value)) {
          writeTypeAndLength(4, value.length);
          for (let i = 0; i < value.length; ++i) encodeItem(value[i]);
        } else if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
          const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
          writeTypeAndLength(2, bytes.length);
          writeUint8Array(bytes);
        } else {
          const keys = Object.keys(value);
          writeTypeAndLength(5, keys.length);
          for (let i = 0; i < keys.length; ++i) {
            encodeItem(keys[i]);
            encodeItem(value[keys[i]]);
          }
        }
      }
    }
  }

  encodeItem(value);

  if ('slice' in data) return data.slice(0, offset);
  const ret = new ArrayBuffer(offset);
  const retView = new DataView(ret);
  for (let i = 0; i < offset; ++i) retView.setUint8(i, dataView.getUint8(i));
  return ret;
}

export function decode(data) {
  const dataView = new DataView(data);
  let offset = 0;

  function commitRead(length, value) {
    offset += length;
    return value;
  }
  function readUint8() {
    return commitRead(1, dataView.getUint8(offset));
  }
  function readUint16() {
    return commitRead(2, dataView.getUint16(offset));
  }
  function readUint32() {
    return commitRead(4, dataView.getUint32(offset));
  }
  function readUint64() {
    return readUint32() * POW_2_32 + readUint32();
  }
  function readArrayBuffer(length) {
    return commitRead(length, new Uint8Array(data, offset, length));
  }
  function readBreak() {
    if (dataView.getUint8(offset) !== 0xff) return false;
    offset += 1;
    return true;
  }
  function readLength(additionalInformation) {
    if (additionalInformation < 24) return additionalInformation;
    if (additionalInformation === 24) return readUint8();
    if (additionalInformation === 25) return readUint16();
    if (additionalInformation === 26) return readUint32();
    if (additionalInformation === 27) return readUint64();
    if (additionalInformation === 31) return -1;
    throw new Error('Invalid length encoding');
  }
  function readIndefiniteStringLength(majorType) {
    const initialByte = readUint8();
    if (initialByte === 0xff) return -1;
    const length = readLength(initialByte & 0x1f);
    if (length < 0 || initialByte >> 5 !== majorType)
      throw new Error('Invalid indefinite length element');
    return length;
  }

  function appendUtf16Data(utf16data, length) {
    for (let i = 0; i < length; ++i) {
      let value = readUint8();
      if (value & 0x80) {
        if (value < 0xe0) {
          value = ((value & 0x1f) << 6) | (readUint8() & 0x3f);
          length -= 1;
        } else if (value < 0xf0) {
          value = ((value & 0x0f) << 12) | ((readUint8() & 0x3f) << 6) | (readUint8() & 0x3f);
          length -= 2;
        } else {
          value =
            ((value & 0x0f) << 18) |
            ((readUint8() & 0x3f) << 12) |
            ((readUint8() & 0x3f) << 6) |
            (readUint8() & 0x3f);
          length -= 3;
        }
      }
      if (value < 0x10000) {
        utf16data.push(value);
      } else {
        value -= 0x10000;
        utf16data.push(0xd800 | (value >> 10));
        utf16data.push(0xdc00 | (value & 0x3ff));
      }
    }
  }

  function decodeItem() {
    const initialByte = readUint8();
    const majorType = initialByte >> 5;
    const additionalInformation = initialByte & 0x1f;

    if (majorType === 7) {
      switch (additionalInformation) {
        case 26:
          return readUint32();
        case 27:
          return readUint32() * POW_2_32 + readUint32(); // readFloat64 equivalent for integers
      }
    }

    let length = readLength(additionalInformation);
    let i;
    switch (majorType) {
      case 0:
        return length;
      case 1:
        return -1 - length;
      case 2: {
        if (length < 0) {
          const elements = [];
          let fullArrayLength = 0;
          while ((length = readIndefiniteStringLength(majorType)) >= 0) {
            fullArrayLength += length;
            elements.push(readArrayBuffer(length));
          }
          const fullArray = new Uint8Array(fullArrayLength);
          let fullArrayOffset = 0;
          for (i = 0; i < elements.length; ++i) {
            fullArray.set(elements[i], fullArrayOffset);
            fullArrayOffset += elements[i].length;
          }
          return fullArray;
        }
        return readArrayBuffer(length);
      }
      case 3: {
        const utf16data = [];
        if (length < 0) {
          while ((length = readIndefiniteStringLength(majorType)) >= 0)
            appendUtf16Data(utf16data, length);
        } else {
          appendUtf16Data(utf16data, length);
        }
        return String.fromCharCode.apply(null, utf16data);
      }
      case 4: {
        const retArray = [];
        if (length < 0) {
          while (!readBreak()) retArray.push(decodeItem());
        } else {
          for (i = 0; i < length; ++i) retArray[i] = decodeItem();
        }
        return retArray;
      }
      case 5: {
        const retObject = {};
        for (i = 0; i < length || (length < 0 && !readBreak()); ++i) {
          const key = decodeItem();
          retObject[key] = decodeItem();
        }
        return retObject;
      }
      case 6: {
        // tagged item - not used by MCUmgr, return raw value
        return decodeItem();
      }
      case 7: {
        switch (length) {
          case 20:
            return false;
          case 21:
            return true;
          case 22:
            return null;
          case 23:
            return undefined;
          default:
            return undefined;
        }
      }
    }
  }

  const ret = decodeItem();
  if (offset !== data.byteLength) throw new Error('Remaining bytes');
  return ret;
}
