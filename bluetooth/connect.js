import { ALL_OPTIONAL_SERVICES, REGISTRY, LEGACY_DFU_UUID } from '../core/registry.js';
import { normalizeUuid } from '../core/filter-store.js';

export const SMP_SERVICE_UUID     = '8d53dc1d-1db7-4cd3-868b-8a527460aa84';
export const SMP_CHAR_UUID        = 'da2e7828-fbce-4e01-ae9e-261174997c48';

/**
 * Connect to a BLE device using the provided filter configuration.
 *
 * @param {object} filterConfig
 * @param {boolean} filterConfig.scanAll      — show every BLE device in the picker
 * @param {string}  filterConfig.namePrefix   — optional device-name prefix filter
 * @param {string}  filterConfig.serviceUuid  — optional service UUID filter
 * @param {function} onDisconnect             — callback when GATT disconnects
 */
export async function connectToDevice(filterConfig, onDisconnect) {
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

  const requestArgs = buildRequestArgs(filterConfig);

  const device = await navigator.bluetooth.requestDevice(requestArgs);

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

/**
 * Reconnect to an existing BluetoothDevice by MAC address — no picker.
 * Retries gatt.connect() up to 10 times with 1s backoff to handle boot delays.
 *
 * @param {BluetoothDevice} device    — previously-granted device object
 * @param {function}        onDisconnect
 */
export async function reconnectToDevice(device, onDisconnect) {
  let server;
  const maxRetries = 10;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      server = await device.gatt.connect();
      break;
    } catch (err) {
      if (attempt === maxRetries) throw new Error(`Reconnect failed after ${maxRetries} attempts: ${err.message}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  // Re-enumerate services after reboot (the service set may change)
  const services = await server.getPrimaryServices();
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

/** Build navigator.bluetooth.requestDevice() arguments from user filter config. */
function buildRequestArgs(filterConfig) {
  const optionalServices = [...ALL_OPTIONAL_SERVICES];

  if (filterConfig.scanAll) {
    return {
      acceptAllDevices: true,
      optionalServices,
    };
  }

  const filters = [];

  // Custom service UUID
  const uuid = normalizeUuid(filterConfig.serviceUuid);
  if (uuid) {
    filters.push({ services: [uuid] });
    if (!optionalServices.includes(uuid)) {
      optionalServices.push(uuid);
    }
  }

  // Custom name prefix
  const prefix = (filterConfig.namePrefix || '').trim();
  if (prefix) {
    filters.push({ namePrefix: prefix });
  }

  // Fallback defaults when the user left both fields empty
  if (filters.length === 0) {
    filters.push(
      { services: [REGISTRY.smp.serviceUuid] },
      { services: [REGISTRY.nordic.serviceUuid] },
      { namePrefix: REGISTRY.nordic.namePrefix },
      { namePrefix: 'Nordic_Buttonless' },
      { namePrefix: 'DfuTest' },
    );
  }

  return { filters, optionalServices };
}
