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
    # Kubernetes operator work: the `ci` toolchain plus an envtest control plane (etcd,
    # kube-apiserver, kube-controller-manager as plain processes), kubectl, Helm and
    # actionlint. `cargo test -p scribyra-operator` needs nothing else.
    operator = pkgs.mkShell {
      packages = with pkgs; [ (rust-bin.stable.latest.default.override { targets = [ "wasm32-unknown-unknown" ]; }) pkg-config openssl git kubernetes etcd kubectl kubernetes-helm actionlint garage ];
      SCRIBYRA_ENVTEST_REQUIRED = "1";
    };
    default = pkgs.mkShell {
      buildInputs = [ pkgs.glib ];
      packages = with pkgs; [ (rust-bin.stable.latest.default.override { targets = [ "wasm32-unknown-unknown" ]; }) nodejs_22 wasm-bindgen-cli pkg-config openssl nginx haproxy git chromium python3 playwright-driver.browsers openssh postgresql_17 garage ];
      PLAYWRIGHT_BROWSERS_PATH = "${pkgs.playwright-driver.browsers}";
      PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "true";
      PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = if pkgs.stdenv.hostPlatform.isLinux then "${pkgs.chromium}/bin/chromium" else "";
    }; });
  };
}
