/** CRC-32 (IEEE 802.3) implementation matching Nordic's crc32_compute().
 *  Provenance: project-local implementation (not vendored from a third-party package).
 *  Produces results identical to the reference test vector for '123456789'.
 */

const CRC32_TABLE = [];
for (let n = 0; n < 256; ++n) {
    let c = n;
    for (let k = 0; k < 8; ++k) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    CRC32_TABLE[n] = c >>> 0;
}

/** Compute CRC-32 of a Uint8Array. Optional seed for incremental calculation. */
export function crc32(buf, seed) {
    let crc = (seed === undefined) ? 0xFFFFFFFF : (seed ^ 0xFFFFFFFF);
    for (let i = 0; i < buf.length; i++) {
        crc = CRC32_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

export const CRC32 = {
    buf: (bytes, seed) => crc32(bytes, seed),
    str: (str, seed) => crc32(new TextEncoder().encode(str), seed),
};
