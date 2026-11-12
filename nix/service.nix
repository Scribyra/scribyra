{ pkgs }:
let
  rust = pkgs.rust-bin.stable.latest.default;
  platform = pkgs.makeRustPlatform { cargo = rust; rustc = rust; };
  service = platform.buildRustPackage {
    pname = "scribyra-sync";
    version = "0.1.0-s1";
    src = pkgs.lib.cleanSource ../.;
    cargoLock.lockFile = ../Cargo.lock;
    cargoBuildFlags = [ "-p" "scribyra-sync" "--bin" "scribyra-sync" ];
    cargoTestFlags = [ "-p" "scribyra-sync" "--bin" "scribyra-sync" ];
    postInstall = ''
      find "$out/bin" -type f ! -name scribyra-sync -delete
    '';
    meta.license = pkgs.lib.licenses.agpl3Only;
  };
in {
  inherit service;
  service-image = pkgs.dockerTools.buildLayeredImage {
    name = "scribyra-sync";
    tag = "0.1.0-s1";
    created = "1970-01-01T00:00:01Z";
    contents = [ service pkgs.cacert ];
    extraCommands = ''mkdir -m 1777 data'';
    config = {
      Entrypoint = [ "${service}/bin/scribyra-sync" ];
      User = "10001:10001";
      Env = [ "SCRIBYRA_SERVICE_BIND=0.0.0.0:8787" "SCRIBYRA_SERVICE_DATA=/data" ];
      ExposedPorts."8787/tcp" = { };
      Volumes."/data" = { };
    };
  };
}
