import { Op, Group, ImageCmd, OsCmd } from './protocol.js';

const MCUBOOT_MAGIC = 0x96f3b83d;

/** Throws if data doesn't look like a signed MCUboot image. */
export function validateImage(data) {
  if (data.byteLength < 32) throw new Error('File too small to be a valid MCUboot image.');
  const magic = new DataView(data.buffer, data.byteOffset).getUint32(0, true);
  if (magic !== MCUBOOT_MAGIC) {
    throw new Error(
      `Bad MCUboot magic: 0x${magic.toString(16).padStart(8, '0')} — use zephyr.signed.bin`,
    );
  }
}

/**
 * Returns array of image slot descriptors from the device.
 * Each: { slot, version, hash, active, pending, confirmed }
 */
export async function listImages(client) {
  const rsp = await client.send(Op.ReadReq, Group.Image, ImageCmd.State, {});
  const images = rsp.payload.images ?? [];
  return images.map((img) => ({
    slot:      img.slot,
    version:   fmtVersion(img.version),
    hash:      bufToHex(img.hash),
    active:    !!img.active,
    pending:   !!img.pending,
    confirmed: !!img.confirmed,
  }));
}

/**
 * Uploads firmware to the device in chunkSize-byte chunks.
 * onProgress({ offset, total }) called after each chunk.
 */
export async function uploadFirmware(client, data, onProgress, chunkSize = 128) {
  const total = data.byteLength;
  const sha   = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  let offset  = 0;

  while (offset < total) {
    const chunk   = data.slice(offset, offset + chunkSize);
    const payload = { off: offset, data: chunk };
    if (offset === 0) { payload.len = total; payload.sha = sha; }

    const rsp = await client.send(Op.WriteReq, Group.Image, ImageCmd.Upload, payload, chunkSize + 32);

    const rc = rsp.payload.rc;
    if (rc !== undefined && rc !== 0) throw new Error(`Upload error rc=${rc} at offset ${offset}`);

    const nextOff = rsp.payload.off ?? offset + chunk.byteLength;
    console.debug(`[DFU] chunk offset=${offset} → device ack'd off=${nextOff} rc=${rc ?? 0}`);
    offset = nextOff;
    onProgress({ offset, total });
  }
}

/** Mark image in slot 1 for testing on next boot. */
export async function testImage(client, hexHash) {
  const rsp = await client.send(Op.WriteReq, Group.Image, ImageCmd.State,
    { hash: hexToBuf(hexHash), confirm: false });
  const rc = rsp.payload.rc;
  if (rc !== undefined && rc !== 0) throw new Error(`Image test failed rc=${rc}`);
}

/** Confirm the currently running image permanently. */
export async function confirmImage(client, hexHash) {
  const rsp = await client.send(Op.WriteReq, Group.Image, ImageCmd.State,
    { hash: hexToBuf(hexHash), confirm: true });
  const rc = rsp.payload.rc;
  if (rc !== undefined && rc !== 0) throw new Error(`Image confirm failed rc=${rc}`);
}

/** Reset the device. No response expected — device reboots immediately. */
export async function resetDevice(client) {
  try {
    await client.send(Op.WriteReq, Group.OS, OsCmd.Reset, {});
  } catch {
    // Timeout is expected — device disconnects on reset
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function bufToHex(buf) {
  return Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBuf(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return out;
}

function fmtVersion(v) {
  // mcumgr encodes the image version as a string, e.g. "2.0.0".
  return typeof v === 'string' && v ? v : 'unknown';
}
