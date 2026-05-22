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
HEX     := $(BUILD)/merged.hex
V2_BIN  := $(BUILD2)/firmware/zephyr/zephyr.signed.bin
V2_VER  := 2.0.0

WEST := nrfutil sdk-manager toolchain launch --ncs-version $(NCS) --chdir $(NCS_DIR) -- west

.PHONY: build build-v1 build-v2 flash test dfu harness-deps clean

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

clean:
	rm -rf $(BUILD) $(BUILD2)
