## Third-Party Notices

This project vendors or ports code from the following third-party projects.

### Provenance checklist

| File                        | Origin                                        | License                  |
| --------------------------- | --------------------------------------------- | ------------------------ |
| `vendor/jszip.js`           | JSZip v3.10.1 (vendored wrapper)              | MIT OR GPL-3.0           |
| `vendor/jszip.mjs`          | JSZip v3.10.1 (vendored bundle)               | MIT OR GPL-3.0           |
| `nordic/secure-dfu.js`      | Adapted from web-bluetooth-dfu                | MIT                      |
| `nordic/nordic-provider.js` | Adapted from web-bluetooth-dfu flow           | MIT                      |
| `nordic/package.js`         | Adapted from web-bluetooth-dfu package parser | MIT                      |
| `vendor/crc32.js`           | Project-local implementation                  | MIT (repository license) |

### JSZip (vendored bundle)

- Files: `vendor/jszip.js`, `vendor/jszip.mjs`
- Upstream: https://github.com/Stuk/jszip
- Version: 3.10.1
- License: MIT OR GPL-3.0 (upstream dual license)

`vendor/jszip.mjs` includes the bundled upstream license banner.

### web-bluetooth-dfu (ported logic)

- Files: `nordic/secure-dfu.js`, `nordic/nordic-provider.js`, `nordic/package.js`
- Upstream: https://github.com/thegecko/web-bluetooth-dfu
- License: MIT

Ported Nordic Secure DFU flow and protocol handling were adapted into this
project's ES module structure.

### CRC-32 implementation

- File: `vendor/crc32.js`
- Source: project-local implementation of the standard CRC-32 (IEEE 802.3)
  algorithm used by Nordic DFU checksum validation
- License: distributed under this repository's terms
