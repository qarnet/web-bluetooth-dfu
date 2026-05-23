const STORAGE_KEY = 'dfu-filter-config';

const DEFAULTS = {
  scanAll:    true,
  namePrefix: '',
  serviceUuid: '',
};

/** Load filter configuration from localStorage (or defaults). */
export function loadFilterConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    return {
      scanAll:     typeof parsed.scanAll === 'boolean' ? parsed.scanAll : DEFAULTS.scanAll,
      namePrefix:  String(parsed.namePrefix || ''),
      serviceUuid: String(parsed.serviceUuid || ''),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Save filter configuration to localStorage. */
export function saveFilterConfig(config) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // ignore (private mode, quota exceeded, etc.)
  }
}

/** Check whether a string looks like a valid Bluetooth UUID. */
export function isValidUuid(str) {
  if (!str) return false;
  const re = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  return re.test(str);
}

/** Convert a short 16-bit UUID form to full 128-bit if needed. */
export function normalizeUuid(str) {
  if (!str) return '';
  str = str.trim().toLowerCase();
  if (str.length === 4) {
    return `0000${str}-0000-1000-8000-00805f9b34fb`;
  }
  return str;
}
