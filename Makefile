# A→B→C→D DFU workflow driver.
#   A  write code   — you / the agent edit firmware/src or smp/*.js
#   B  make build   — west builds v1 baseline + v2 update image
#   C  make flash   — flash the v1 baseline to the device
#   D  make test    — flash baseline, then run the headless BLE DFU harness
#   make dfu        — B + D (full loop after a code change)

REPO    := $(CURDIR)
BOARD   := nrf52840dk/nrf52840
NCS     := v3.3.0
NCS_DIR := $(HOME)/ncs/$(NCS)
SRC     := $(REPO)/firmware
BUILD   := $(SRC)/build
BUILD2  := $(SRC)/build-v2
HEX     := $(REPO)/test/fixtures/smp/merged.hex
V2_BIN  := $(REPO)/test/fixtures/smp/zephyr.signed.bin
V2_VER  := 2.0.0

WEST := nrfutil sdk-manager toolchain launch --ncs-version $(NCS) --chdir $(NCS_DIR) -- west

.PHONY: build build-v1 build-v2 flash test test-nordic dfu serve serve-lan harness-deps browser-test browser-test-headless browser-test-nordic browser-test-nordic-headless browser-test-nordic-multi browser-test-nordic-multi-headless clean

build: build-v1 build-v2

build-v1:
	$(WEST) build -b $(BOARD) --sysbuild --build-dir $(BUILD) $(SRC)

build-v2:
	$(WEST) build -b $(BOARD) --sysbuild --build-dir $(BUILD2) $(SRC) \
	  -- -Dfirmware_CONFIG_MCUBOOT_IMGTOOL_SIGN_VERSION='"$(V2_VER)"'

flash:
	nrfutil device program --firmware $(HEX) --traits jlink
	nrfutil device reset --traits jlink

harness-deps:
	cd $(REPO)/tools && npm install --cache "$${TMPDIR:-/tmp}/npm-cache"

test: flash
	node $(REPO)/tools/dfu-test.mjs $(V2_BIN)

dfu: build test

# ── Browser end-to-end tests (require serve.py running) ───────────────────

# SMP browser DFU test — flash baseline, run Puppeteer-driven Chrome test
browser-test: flash
	node $(REPO)/tools/browser-dfu-test.mjs $(V2_BIN)

# Same test under a virtual X server (no GUI required). Chrome runs headed
# against Xvfb so Web Bluetooth still works. Requires xvfb-run + a BLE
# adapter visible to BlueZ (e.g. usbipd-attached BT400).
browser-test-headless: flash
	xvfb-run -a --server-args="-screen 0 1280x900x24" \
	  node $(REPO)/tools/browser-dfu-test.mjs $(V2_BIN)

# Nordic browser DFU test — requires Nordic bootloader + ZIP argument
# Usage: make browser-test-nordic ZIP=path/to/package.zip
browser-test-nordic:
	$(if $(ZIP),, $(error ZIP variable not set. Usage: make browser-test-nordic ZIP=path/to/package.zip))
	node $(REPO)/tools/nordic-browser-dfu-test.mjs $(ZIP)

browser-test-nordic-headless:
	$(if $(ZIP),, $(error ZIP variable not set. Usage: make browser-test-nordic-headless ZIP=path/to/package.zip))
	xvfb-run -a --server-args="-screen 0 1280x900x24" \
	  node $(REPO)/tools/nordic-browser-dfu-test.mjs $(ZIP)

# Multi-image Nordic browser DFU test
browser-test-nordic-multi:
	$(if $(ZIP),, $(error ZIP variable not set. Usage: make browser-test-nordic-multi ZIP=path/to/package.zip))
	node $(REPO)/tools/nordic-browser-dfu-test.mjs --multi-image $(ZIP)

browser-test-nordic-multi-headless:
	$(if $(ZIP),, $(error ZIP variable not set. Usage: make browser-test-nordic-multi-headless ZIP=path/to/package.zip))
	xvfb-run -a --server-args="-screen 0 1280x900x24" \
	  node $(REPO)/tools/nordic-browser-dfu-test.mjs --multi-image $(ZIP)

clean:
	rm -rf $(BUILD) $(BUILD2)
