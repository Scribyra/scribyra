{ config, lib, pkgs, ... }:
let cfg = config.services.scribyra-sync;
in {
  options.services.scribyra-sync = {
    enable = lib.mkEnableOption "Scribyra opaque storage and connection service";
    package = lib.mkOption { type = lib.types.package; description = "The pinned flake's packages.<system>.service."; };
    configFile = lib.mkOption { type = lib.types.path; description = "Operator JSON configuration file (hashes only, never bearer values)."; };
  };
  config = lib.mkIf cfg.enable {
    systemd.services.scribyra-sync = {
      description = "Scribyra opaque service";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];
      environment = {
        SCRIBYRA_SERVICE_CONFIG = toString cfg.configFile;
        SCRIBYRA_SERVICE_DATA = "/var/lib/scribyra-sync";
      };
      serviceConfig = {
        ExecStart = "${cfg.package}/bin/scribyra-sync";
        DynamicUser = true;
        StateDirectory = "scribyra-sync";
        StateDirectoryMode = "0700";
        UMask = "0077";
        Restart = "on-failure";
        TimeoutStopSec = 30;
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        PrivateDevices = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectControlGroups = true;
        RestrictSUIDSGID = true;
        RestrictAddressFamilies = [ "AF_INET" "AF_INET6" "AF_UNIX" ];
        CapabilityBoundingSet = "";
      };
    };
  };
}
