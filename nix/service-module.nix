{ config, lib, pkgs, ... }:
let
  cfg = config.services.scribyra-sync;
  inherit (lib) mkOption types;
  user = "scribyra-sync";
  local = cfg.database.createLocally;
  s3 = cfg.blobStore.type == "s3";
in {
  options.services.scribyra-sync = {
    enable = lib.mkEnableOption "Scribyra opaque storage and connection service";
    package = mkOption { type = types.package; description = "The pinned flake's packages.<system>.service."; };
    configFile = mkOption {
      type = types.path;
      description = ''
        Operator JSON configuration file (hashes only, never bearer values). Leave the
        database and blob-store fields out: this module sets them through the environment.
      '';
    };
    database = {
      createLocally = mkOption {
        type = types.bool;
        default = true;
        description = ''
          Create database and role `scribyra-sync` in the local services.postgresql and connect
          over its unix socket with peer authentication (no password exists).
        '';
      };
      urlFile = mkOption {
        type = types.nullOr types.path;
        default = null;
        example = "/run/secrets/scribyra-database-url";
        description = ''
          File holding an external PostgreSQL URL (for TLS add sslmode=verify-full). Passed with
          LoadCredential, so it may stay root-only. Requires createLocally = false.
        '';
      };
    };
    blobStore = {
      type = mkOption { type = types.enum [ "filesystem" "s3" ]; default = "filesystem"; description = "Filesystem blobs live under /var/lib/scribyra-sync."; };
      s3 = {
        endpoint = mkOption { type = types.str; default = ""; example = "https://<account>.r2.cloudflarestorage.com"; description = "HTTPS endpoint (plain http only for loopback)."; };
        region = mkOption { type = types.str; default = ""; example = "auto"; description = "Signing region."; };
        bucket = mkOption { type = types.str; default = ""; description = "Bucket name."; };
        accessKeyId = mkOption { type = types.str; default = ""; description = "Access key ID (not secret)."; };
        secretAccessKeyFile = mkOption { type = types.nullOr types.path; default = null; description = "File holding the secret access key; passed with LoadCredential."; };
        pathStyle = mkOption { type = types.bool; default = false; description = "Path-style addressing (Garage, MinIO, IP endpoints)."; };
      };
    };
  };
  config = lib.mkIf cfg.enable {
    assertions = [
      { assertion = local != (cfg.database.urlFile != null); message = "services.scribyra-sync: set database.urlFile exactly when database.createLocally is false."; }
      { assertion = !s3 || (cfg.blobStore.s3.endpoint != "" && cfg.blobStore.s3.region != "" && cfg.blobStore.s3.bucket != "" && cfg.blobStore.s3.accessKeyId != "" && cfg.blobStore.s3.secretAccessKeyFile != null); message = "services.scribyra-sync: incomplete blobStore.s3 settings."; }
    ];
    # A fixed system user (not DynamicUser) so PostgreSQL peer authentication can map it.
    users.users.${user} = { isSystemUser = true; group = user; };
    users.groups.${user} = { };
    services.postgresql = lib.mkIf local {
      enable = true;
      ensureDatabases = [ user ];
      ensureUsers = [{ name = user; ensureDBOwnership = true; }];
    };
    systemd.services.scribyra-sync = {
      description = "Scribyra opaque service";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ] ++ lib.optionals local [ "postgresql.service" "postgresql-setup.service" ];
      requires = lib.optionals local [ "postgresql.service" "postgresql-setup.service" ];
      environment = {
        SCRIBYRA_SERVICE_CONFIG = toString cfg.configFile;
        SCRIBYRA_SERVICE_DATA = "/var/lib/scribyra-sync";
        SCRIBYRA_SERVICE_BLOB_STORE = cfg.blobStore.type;
      } // (if local then {
        SCRIBYRA_SERVICE_DATABASE_URL = "postgres:///${user}?host=/run/postgresql&user=${user}";
      } else {
        SCRIBYRA_SERVICE_DATABASE_URL_FILE = "%d/database-url";
      }) // lib.optionalAttrs s3 {
        SCRIBYRA_SERVICE_S3_ENDPOINT = cfg.blobStore.s3.endpoint;
        SCRIBYRA_SERVICE_S3_REGION = cfg.blobStore.s3.region;
        SCRIBYRA_SERVICE_S3_BUCKET = cfg.blobStore.s3.bucket;
        SCRIBYRA_SERVICE_S3_ACCESS_KEY_ID = cfg.blobStore.s3.accessKeyId;
        SCRIBYRA_SERVICE_S3_SECRET_ACCESS_KEY_FILE = "%d/s3-secret";
        SCRIBYRA_SERVICE_S3_PATH_STYLE = lib.boolToString cfg.blobStore.s3.pathStyle;
      };
      serviceConfig = {
        ExecStart = "${cfg.package}/bin/scribyra-sync";
        User = user;
        Group = user;
        LoadCredential = lib.optional (!local) "database-url:${toString cfg.database.urlFile}"
          ++ lib.optional s3 "s3-secret:${toString cfg.blobStore.s3.secretAccessKeyFile}";
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
        RemoveIPC = true;
        RestrictAddressFamilies = [ "AF_INET" "AF_INET6" "AF_UNIX" ];
        CapabilityBoundingSet = "";
      };
    };
  };
}
