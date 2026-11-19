# The Kubernetes operator and the images it deploys besides the service's own
# (`nix/service.nix`): built from this checkout, Cargo.lock and flake.lock, with no
# mutable base image. Each system builds natively (x86_64-linux and aarch64-linux in
# the flake); a multi-arch manifest is assembled from both in CI (docs/operator.md).
{ pkgs }:
let
  rust = pkgs.rust-bin.stable.latest.default;
  platform = pkgs.makeRustPlatform { cargo = rust; rustc = rust; };
  version = (builtins.fromTOML (builtins.readFile ../Cargo.toml)).workspace.package.version;
  operator = platform.buildRustPackage {
    pname = "scribyra-operator";
    inherit version;
    src = pkgs.lib.cleanSource ../.;
    cargoLock.lockFile = ../Cargo.lock;
    cargoBuildFlags = [ "-p" "scribyra-operator" "--bin" "scribyra-operator" ];
    # The integration tests need a control plane; `nix develop .#operator` runs them.
    doCheck = false;
    postInstall = ''
      find "$out/bin" -type f ! -name scribyra-operator -delete
    '';
    meta.license = pkgs.lib.licenses.agpl3Only;
    meta.mainProgram = "scribyra-operator";
  };
  user = "10001:10001";
  inherit (import ./service.nix { inherit pkgs; }) service;
  # What the WebAssembly engine binds read-only into each job's sandbox: Node 22 and the shell
  # its wrapper needs, as a list of store paths (`SCRIBYRA_WASM_CLOSURE`).
  wasmClosure = pkgs.closureInfo { rootPaths = [ pkgs.nodejs_22 pkgs.bash pkgs.coreutils ]; };
in {
  inherit operator;
  # The operator; also the Garage TLS proxy (`scribyra-operator tls-proxy`).
  operator-image = pkgs.dockerTools.buildLayeredImage {
    name = "scribyra-operator";
    tag = version;
    created = "1970-01-01T00:00:01Z";
    contents = [ operator ];
    config = {
      Entrypoint = [ "${operator}/bin/scribyra-operator" ];
      Cmd = [ "run" ];
      User = user;
      ExposedPorts."8080/tcp" = { };
    };
  };
  # Single-node object storage for small installs (Garage 1.x from nixpkgs, AGPL-3.0; the operator speaks its v1 admin API).
  garage-image = pkgs.dockerTools.buildLayeredImage {
    name = "scribyra-garage";
    tag = pkgs.garage_1.version;
    created = "1970-01-01T00:00:01Z";
    contents = [ pkgs.garage_1 ];
    config = {
      Entrypoint = [ "${pkgs.garage_1}/bin/garage" ];
      Cmd = [ "server" ];
      User = user;
    };
  };
  # The compile worker: `workerImage ./path/to/compile-runtime` (the output of
  # `node scripts/wasm-compile-runtime.mjs <dir>` from a built checkout: the browser's BusyTeX
  # WebAssembly engine, the compile driver and the bundled package archives). The service binary,
  # bubblewrap, Node 22 and its closure; no TeX Live (docs/compile-engines.md). The package cache
  # is a volume the operator mounts at /var/cache/scribyra/tex.
  workerImage = runtime: pkgs.dockerTools.buildLayeredImage {
    name = "scribyra-worker";
    tag = version;
    created = "1970-01-01T00:00:01Z";
    contents = [ service pkgs.bubblewrap pkgs.cacert ];
    extraCommands = ''
      mkdir -p opt/scribyra var/cache/scribyra/tex tmp
      cp -r --no-preserve=mode ${runtime} opt/scribyra/compile-runtime
      chmod -R a-w opt/scribyra/compile-runtime
    '';
    config = {
      Entrypoint = [ "${service}/bin/scribyra-sync" ];
      Cmd = [ "compile-worker" ];
      User = user;
      Env = [
        "SCRIBYRA_BWRAP=${pkgs.bubblewrap}/bin/bwrap"
        "SCRIBYRA_NODE=${pkgs.nodejs_22}/bin/node"
        "SCRIBYRA_WASM_CLOSURE=${wasmClosure}/store-paths"
        "SCRIBYRA_SERVICE_COMPILE_RUNTIME=/opt/scribyra/compile-runtime"
        "SCRIBYRA_SERVICE_COMPILE_CACHE=/var/cache/scribyra/tex"
        "SCRIBYRA_COMPILE_CGROUP=/sys/fs/cgroup"
      ];
      ExposedPorts."8788/tcp" = { };
      ExposedPorts."9090/tcp" = { };
    };
  };
  # The static web app: `webImage ./path/to/built/app` (the output of `npm run build`).
  # A static file server only; no shell, no network access needed.
  webImage = app: pkgs.dockerTools.buildLayeredImage {
    name = "scribyra-web";
    tag = version;
    created = "1970-01-01T00:00:01Z";
    contents = [ pkgs.static-web-server ];
    extraCommands = ''
      mkdir -p srv
      cp -r ${app} srv/app
    '';
    config = {
      Entrypoint = [ "${pkgs.static-web-server}/bin/static-web-server" ];
      Cmd = [ "--port" "8080" "--root" "/srv/app" "--page-fallback" "/srv/app/index.html" "--health" "--compression" "true" "--log-level" "info" ];
      User = user;
      ExposedPorts."8080/tcp" = { };
    };
  };
}
