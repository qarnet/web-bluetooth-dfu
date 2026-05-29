{
  description = "web-bluetooth-dfu dev environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        devShells.default =
          let
            nodeDeps = pkgs.buildNpmPackage {
              pname = "web-bluetooth-dfu-dev-deps";
              version = "0.0.0";
              src = ./.;

              # Generated via: nix run nixpkgs#prefetch-npm-deps -- package-lock.json
              npmDepsHash = "sha256-+JRFhaJJL6xr5rI+mCjUgjg1PgRSteF/WJWvlkWVgj8=";

              # These are dev-only tools; no build step needed.
              npmInstallFlags = [ "--ignore-scripts" ];
              dontBuild = true;

              installPhase = ''
                mkdir -p "$out/node_modules" "$out/bin"
                # Copy including hidden entries like .bin
                cp -r node_modules/. "$out/node_modules/"

                # Expose common executables on PATH so `nix develop -c prettier`
                # works even when shellHook isn't run.
                if [ -d "$out/node_modules/.bin" ]; then
                  for exe in "$out"/node_modules/.bin/*; do
                    [ -e "$exe" ] || continue
                    ln -s "$exe" "$out/bin/$(basename "$exe")"
                  done
                fi
              '';
            };
          in
          pkgs.mkShell {
            packages = with pkgs; [
              # General dev tooling
              git
              gnumake
              ripgrep
              jq

              # Runtime for test scripts + tools
              nodejs_22
              python3

              # Dev-only JS tooling (from package-lock.json)
              nodeDeps

              # Useful for local debugging / HIL work
              usbutils
              bluez

              # Browser E2E tests
              xvfb

              # LSP for opencode
              typescript-language-server
            ];

            # Avoid puppeteer trying to download Chrome.
            env.PUPPETEER_SKIP_DOWNLOAD = "1";

            shellHook = ''
              # Provide node_modules without npm install.
              # This symlink is local-only and ignored by git.
              if [ ! -e node_modules ]; then
                ln -s "${nodeDeps}/node_modules" node_modules
              fi

              export PATH="$PWD/node_modules/.bin:$PATH"
            '';
          };
      }
    );
}
