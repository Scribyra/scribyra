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
