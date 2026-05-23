import { ALL_OPTIONAL_SERVICES, REGISTRY, LEGACY_DFU_UUID } from '../core/registry.js';

export const SMP_SERVICE_UUID     = '8d53dc1d-1db7-4cd3-868b-8a527460aa84';
export const SMP_CHAR_UUID        = 'da2e7828-fbce-4e01-ae9e-261174997c48';

/** Connect to the first available BLE device advertising any supported service. */
export async function connectToDevice(onDisconnect) {
  if (!navigator.bluetooth) {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const isHTTP = window.location.protocol !== 'https:';
    let msg = 'Web Bluetooth not available';
    if (isIOS) {
      msg += ' — iOS/iPadOS does not support Web Bluetooth in any browser. Use Android or desktop Chrome.';
    } else if (isHTTP) {
      msg += ' — this page is served over HTTP. Web Bluetooth requires HTTPS or localhost. Reload over HTTPS.';
    } else {
      msg += ' — use Chrome on Android, Windows, macOS, or Linux. Ensure chrome://flags/#enable-web-bluetooth-new-permissions-backend is enabled.';
    }
    throw new Error(msg);
  }

  const filters = [
    { services: [ REGISTRY.smp.serviceUuid ] },
    { services: [ REGISTRY.nordic.serviceUuid ] },
    { namePrefix: REGISTRY.nordic.namePrefix },
    { namePrefix: 'Nordic_Buttonless' },
    { namePrefix: 'DfuTest' },
  ];

  const device = await navigator.bluetooth.requestDevice({
    filters,
    optionalServices: ALL_OPTIONAL_SERVICES,
  });

  // Retry gatt.connect() a few times — the device may still be booting its
  // BLE stack after a firmware reset, which causes transient "Connection
  // attempt failed" errors on the first try.
  let server;
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      server = await device.gatt.connect();
      break;
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  // Guard against legacy DFU (blocked by Chrome anyway, but gives a better message)
  const services = await server.getPrimaryServices();
  for (const svc of services) {
    if (svc.uuid === LEGACY_DFU_UUID) {
      await server.disconnect();
      throw new Error('Legacy DFU (0x1530) is not supported — please upgrade to a Secure DFU bootloader.');
    }
  }

  // Collect discovered services and characteristics for providers
  const serviceMap = new Map();
  for (const service of services) {
    const charMap = new Map();
    for (const characteristic of await service.getCharacteristics()) {
      charMap.set(characteristic.uuid, characteristic);
    }
    serviceMap.set(service.uuid, { service, characteristics: charMap });
  }

  if (onDisconnect) {
    device.addEventListener('gattserverdisconnected', onDisconnect);
  }

  function disconnect() {
    if (onDisconnect) {
      device.removeEventListener('gattserverdisconnected', onDisconnect);
    }
    if (server.connected) server.disconnect();
  }

  return { device, server, services: serviceMap, disconnect };
}
