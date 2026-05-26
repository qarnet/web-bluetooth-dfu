{
  description = "web-bluetooth-dfu dev environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            # General dev tooling
            git
            gnumake
            ripgrep
            jq

            # Runtime for test scripts + tools
            nodejs_22
            python3

            # Useful for local debugging / HIL work
            usbutils
            bluez

            # Browser E2E tests
            # Note: Web Bluetooth works in official Chrome/Edge; Chromium builds
            # can have Web Bluetooth disabled depending on distro packaging.
            xorg.xvfb
          ];

          # Avoid puppeteer trying to download Chrome. Point Puppeteer at your
          # system Chrome/Edge via PUPPETEER_EXECUTABLE_PATH if needed.
          env.PUPPETEER_SKIP_DOWNLOAD = "1";
        };
      });
}
