import { ALL_OPTIONAL_SERVICES, REGISTRY, LEGACY_DFU_UUID } from '../core/registry.js';

export const SMP_SERVICE_UUID     = '8d53dc1d-1db7-4cd3-868b-8a527460aa84';
export const SMP_CHAR_UUID        = 'da2e7828-fbce-4e01-ae9e-261174997c48';

/** Connect to the first available BLE device advertising any supported service. */
export async function connectToDevice(onDisconnect) {
  if (!navigator.bluetooth) {
    throw new Error('Web Bluetooth not available — use Chrome on desktop or Android.');
  }

  const filters = [
    { services: [ REGISTRY.smp.serviceUuid ] },
    { services: [ REGISTRY.nordic.serviceUuid ] },
    { namePrefix: REGISTRY.nordic.namePrefix },
  ];

  const device = await navigator.bluetooth.requestDevice({
    filters,
    optionalServices: ALL_OPTIONAL_SERVICES,
  });

  const server = await device.gatt.connect();

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
