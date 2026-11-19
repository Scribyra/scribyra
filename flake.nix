{
  description = "Scribyra development environment";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  inputs.rust-overlay.url = "github:oxalica/rust-overlay";
  inputs.rust-overlay.inputs.nixpkgs.follows = "nixpkgs";
  outputs = { self, nixpkgs, rust-overlay, ... }: let
    systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" "x86_64-darwin" ];
  in {
    nixosModules.scribyra-sync = import ./nix/service-module.nix;
    packages = nixpkgs.lib.genAttrs systems (system:
      import ./nix/service.nix { pkgs = import nixpkgs { inherit system; overlays = [ rust-overlay.overlays.default ]; }; });
    checks = nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" ] (system: let
      pkgs = import nixpkgs { inherit system; overlays = [ rust-overlay.overlays.default ]; };
    in {
      service-vm = pkgs.testers.runNixOSTest (import ./nix/service-test.nix {
        inherit pkgs;
        service = self.packages.${system}.service;
      });
    });
    devShells = nixpkgs.lib.genAttrs systems (system: let
      pkgs = import nixpkgs { inherit system; overlays = [ rust-overlay.overlays.default ]; };
    in {
    # CI on GitHub-hosted runners: the same toolchain versions as `default`, without
    # what the CI suite never uses (Rust docs/clippy/rustfmt, Firefox and WebKit
    # browsers, nginx, haproxy). It saves about 3 GB of Nix store on a runner whose
    # disk is small; Chromium is the one CI browser.
    ci = pkgs.mkShell {
      buildInputs = [ pkgs.glib ];
      packages = with pkgs; [ (rust-bin.stable.latest.minimal.override { targets = [ "wasm32-unknown-unknown" ]; }) nodejs_22 wasm-bindgen-cli pkg-config openssl git chromium python3 openssh ];
      PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "true";
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
      PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = if pkgs.stdenv.hostPlatform.isLinux then "${pkgs.chromium}/bin/chromium" else "";
    };
    default = pkgs.mkShell {
      buildInputs = [ pkgs.glib ];
      packages = with pkgs; [ (rust-bin.stable.latest.default.override { targets = [ "wasm32-unknown-unknown" ]; }) nodejs_22 wasm-bindgen-cli pkg-config openssl nginx haproxy git chromium python3 playwright-driver.browsers openssh postgresql_17 garage bubblewrap texliveSmall ];
      # The server compile sandbox (crates/compile): bubblewrap, the TeX Live tree and its
      # store closure, which is all the sandbox binds read-only.
      SCRIBYRA_BWRAP = "${pkgs.bubblewrap}/bin/bwrap";
      SCRIBYRA_TEXLIVE = "${pkgs.texliveSmall}";
      SCRIBYRA_TEXLIVE_CLOSURE = "${pkgs.closureInfo { rootPaths = [ pkgs.texliveSmall ]; }}/store-paths";
      # The WebAssembly engine (the default): the pinned Node and the closure the sandbox binds
      # (Node, a bash for the in-namespace rlimits, coreutils for tests). The compile runtime
      # itself comes from `node scripts/wasm-compile-runtime.mjs <dir>` (SCRIBYRA_WASM_RUNTIME).
      SCRIBYRA_NODE = "${pkgs.nodejs_22}/bin/node";
      SCRIBYRA_WASM_CLOSURE = "${pkgs.closureInfo { rootPaths = [ pkgs.nodejs_22 pkgs.bash pkgs.coreutils ]; }}/store-paths";
      PLAYWRIGHT_BROWSERS_PATH = "${pkgs.playwright-driver.browsers}";
      PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "true";
      PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = if pkgs.stdenv.hostPlatform.isLinux then "${pkgs.chromium}/bin/chromium" else "";
    }; });
  };
}
