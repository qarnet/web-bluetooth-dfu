import { REGISTRY, LEGACY_DFU_UUID } from './registry.js';

/** Detect protocol from firmware file bytes. */
export function detectFromFile(data) {
  if (data.byteLength < 4) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const le32 = dv.getUint32(0, true);

  if (le32 === REGISTRY.smp.fileMagic) return 'smp';

  // ZIP magic PK\x03\x04
  if (data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04) {
    return 'nordic';
  }

  return null;
}

/** Detect protocol from connected device services. */
export function detectFromDevice(services) {
  for (const [uuid, info] of services.entries()) {
    if (uuid === LEGACY_DFU_UUID) return 'legacy';
    if (uuid === REGISTRY.smp.serviceUuid) return 'smp';
    if (uuid === REGISTRY.nordic.serviceUuid) {
      const chars = info.characteristics;
      const hasControl = chars.has(REGISTRY.nordic.controlUuid);
      const hasPacket = chars.has(REGISTRY.nordic.packetUuid);
      if (hasControl && hasPacket) return 'nordic';
      const hasButtonless =
        chars.has(REGISTRY.nordic.buttonlessWithoutBondsUuid) ||
        chars.has(REGISTRY.nordic.buttonlessWithBondsUuid);
      if (hasButtonless) return 'nordic-buttonless';
      return 'nordic';
    }
  }
  return null;
}

/**
 * Resolve the final protocol given optional file and device signals.
 * @param {string|null} fileSig
 * @param {string|null} deviceSig
 * @returns {string} 'smp' | 'nordic' | null
 */
export function resolveProtocol(fileSig, deviceSig) {
  if (deviceSig === 'legacy')
    throw new Error(
      'Legacy DFU (0x1530) is not supported — please upgrade to a Secure DFU bootloader.'
    );
  if (deviceSig === 'nordic-buttonless') return 'nordic';

  // Device signal is authoritative
  if (deviceSig) {
    if (fileSig && fileSig !== deviceSig) {
      throw new Error(
        `Device expects ${deviceSig.toUpperCase()} but the selected file is ${fileSig.toUpperCase()}`
      );
    }
    return deviceSig;
  }

  return fileSig || null;
}
