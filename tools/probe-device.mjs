import { createBluetooth } from 'node-ble';

async function main() {
  const { bluetooth, destroy } = createBluetooth();
  try {
    const adapter = await bluetooth.defaultAdapter();
    const dev = await adapter.getDevice('D7:E7:59:AB:C2:CF');
    console.log('Device own keys:', Object.keys(dev));
    console.log('Device proto keys:', Object.getOwnPropertyNames(Object.getPrototypeOf(dev)));
  } finally {
    destroy();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
