# Import on the selected NixOS ingestion host; disabled until explicitly enabled.
{ config, lib, pkgs, ... }:
let
  cfg = config.services.scribyra-ingestion;
in {
  options.services.scribyra-ingestion = {
    enable = lib.mkEnableOption "private Scribyra ingestion";
    checkout = lib.mkOption { type = lib.types.str; default = "/srv/scribyra"; };
    hostname = lib.mkOption { type = lib.types.str; };
    origin = lib.mkOption { type = lib.types.str; };
    acmeEmail = lib.mkOption { type = lib.types.str; };
    cloud = lib.mkOption { type = lib.types.bool; default = false; };
    browserConsent = lib.mkOption { type = lib.types.bool; default = false; description = "Enable origin-checked anonymous browser telemetry after per-category consent."; };
    # Plain configuration only. Secret values are loaded from runtime files.
    environmentFile = lib.mkOption { type = lib.types.str; default = "/etc/scribyra/ingestion.env"; };
  };
  config = lib.mkIf cfg.enable {
    users.groups.scribyra-telemetry = {};
    users.users.scribyra-telemetry = { isSystemUser = true; group = "scribyra-telemetry"; home = "/var/lib/scribyra-ingestion"; };
    systemd.services.scribyra-ingestion = {
      description = "Scribyra private telemetry stack";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      path = [ pkgs.nix pkgs.git ];
      environment = {
        GIT_CONFIG_COUNT = "1";
        GIT_CONFIG_KEY_0 = "safe.directory";
        GIT_CONFIG_VALUE_0 = cfg.checkout;
        SCRIBYRA_BROWSER_INGESTION = if cfg.browserConsent then "1" else "0";
      } // lib.optionalAttrs cfg.cloud {
        SCRIBYRA_CLOUD_USERNAME_FILE = "%d/cloud-username";
        SCRIBYRA_CLOUD_TOKEN_FILE = "%d/cloud-token";
      };
      serviceConfig = {
        Type = "simple";
        User = "scribyra-telemetry";
        Group = "scribyra-telemetry";
        WorkingDirectory = cfg.checkout;
        EnvironmentFile = cfg.environmentFile;
        LoadCredential = lib.optionals cfg.cloud [
          "cloud-username:/etc/scribyra/cloud.username"
          "cloud-token:/etc/scribyra/cloud.ingest-token"
        ];
        StateDirectory = "scribyra-ingestion";
        StateDirectoryMode = "0700";
        UMask = "0077";
        ExecStart = "${pkgs.nix}/bin/nix develop --offline -c python3 scripts/telemetry-stack.py --state /var/lib/scribyra-ingestion --port-base 18789 --ingress-binary target/release/scribyra-telemetry --origin ${lib.escapeShellArg cfg.origin} ${if cfg.cloud then "--cloud" else "--grafana"}";
        Restart = "on-failure";
        RestartSec = 5;
        TimeoutStopSec = 180;
        KillMode = "control-group";
        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        ReadWritePaths = [ "/var/lib/scribyra-ingestion" ];
        MemoryMax = "3G";
        TasksMax = 256;
        LimitCORE = 0;
      };
    };
    security.acme = { acceptTerms = true; defaults.email = cfg.acmeEmail; };
    services.nginx.enable = true;
    services.nginx.virtualHosts.${cfg.hostname} = {
      enableACME = true;
      forceSSL = true;
      extraConfig = "client_max_body_size 64k; access_log off;";
      locations = {
        "= /v1/events" = {
          proxyPass = "http://127.0.0.1:18789";
          extraConfig = "if ($request_method !~ ^(POST|OPTIONS)$) { return 405; }\nproxy_read_timeout 10s;";
        };
        "= /v1/runs" = {
          proxyPass = "http://127.0.0.1:18789";
          extraConfig = "if ($request_method != POST) { return 405; }\nproxy_read_timeout 10s;";
        };
        "/".return = "404";
      } // lib.optionalAttrs cfg.browserConsent {
        "= /v1/browser-events" = {
          proxyPass = "http://127.0.0.1:18789";
          extraConfig = "if ($request_method !~ ^(POST|OPTIONS)$) { return 405; }\nproxy_read_timeout 10s;";
        };
      };
    };
    networking.firewall.allowedTCPPorts = [ 80 443 ];
  };
}
