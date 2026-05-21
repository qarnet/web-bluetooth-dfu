export const SMP_SERVICE_UUID = '8d53dc1d-1db7-4cd3-868b-8a527460aa84';
export const SMP_CHAR_UUID    = 'da2e7828-fbce-4e01-ae9e-261174997c48';

/**
 * Opens the browser BLE device picker filtered to SMP devices,
 * connects, and returns { device, server, characteristic, disconnect }.
 * onDisconnect() called on unexpected disconnection.
 */
export async function connectToDevice(onDisconnect) {
  if (!navigator.bluetooth) {
    throw new Error('Web Bluetooth not available — use Chrome on desktop or Android.');
  }

  const device = await navigator.bluetooth.requestDevice({
    filters: [{ services: [SMP_SERVICE_UUID] }],
    optionalServices: [SMP_SERVICE_UUID],
  });

  const server         = await device.gatt.connect();
  const service        = await server.getPrimaryService(SMP_SERVICE_UUID);
  const characteristic = await service.getCharacteristic(SMP_CHAR_UUID);

  device.addEventListener('gattserverdisconnected', onDisconnect);

  function disconnect() {
    device.removeEventListener('gattserverdisconnected', onDisconnect);
    if (server.connected) server.disconnect();
  }

  return { device, server, characteristic, disconnect };
}
