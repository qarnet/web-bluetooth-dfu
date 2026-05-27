export const LEGACY_DFU_UUID = '00001530-1212-efde-1523-785feabcd123';

export const REGISTRY = {
  smp: {
    id: 'smp',
    label: 'SMP / MCUboot',
    serviceUuid: '8d53dc1d-1db7-4cd3-868b-8a527460aa84',
    charUuid: 'da2e7828-fbce-4e01-ae9e-261174997c48',
    fileMagic: 0x96f3b83d, // LE uint32 at offset 0
    fileExt: '.bin',
  },
  nordic: {
    id: 'nordic',
    label: 'Nordic Secure DFU',
    // Service UUID is the 16-bit Nordic DFU service (0xFE59)
    serviceUuid: '0000fe59-0000-1000-8000-00805f9b34fb',
    namePrefix: 'DfuTarg',
    controlUuid: '8ec90001-f315-4f60-9fb8-838830daea50',
    packetUuid: '8ec90002-f315-4f60-9fb8-838830daea50',
    buttonlessWithoutBondsUuid: '8ec90003-f315-4f60-9fb8-838830daea50',
    buttonlessWithBondsUuid: '8ec90004-f315-4f60-9fb8-838830daea50',
    fileMagic: null, // ZIP magic 0x504b0304 handled by detect.js
    fileExt: '.zip',
  },
};

/** All service UUIDs that the connect layer must declare up front. */
export const ALL_SERVICE_UUIDS = [REGISTRY.smp.serviceUuid, REGISTRY.nordic.serviceUuid];

/** All optional services that must be declared for getPrimaryService. */
export const ALL_OPTIONAL_SERVICES = ALL_SERVICE_UUIDS;
