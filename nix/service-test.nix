{ pkgs, service }:
let
  bearer = pkgs.lib.concatStrings (pkgs.lib.replicate 64 "1");
  namespace = pkgs.lib.concatStrings (pkgs.lib.replicate 64 "2");
  bytes = "opaque-service-vm-fixture";
  object = "/v1/objects/${namespace}/${builtins.hashString "sha256" bytes}";
  configFile = pkgs.writeText "service-test.json" (builtins.toJSON {
    principals = [{
      token_hash = builtins.hashString "sha256" bearer;
      inherit namespace;
      storage = true;
      relay = true;
    }];
  });
  # The same environment the unit gets, for the offline verify command.
  verify = "runuser -u scribyra-sync -- env SCRIBYRA_SERVICE_CONFIG=${configFile} SCRIBYRA_SERVICE_DATA=/var/lib/scribyra-sync 'SCRIBYRA_SERVICE_DATABASE_URL=postgres:///scribyra-sync?host=/run/postgresql&user=scribyra-sync' ${service}/bin/scribyra-sync verify";
in {
  name = "scribyra-service";
  # Permit the same test to run with software QEMU in hosts without /dev/kvm.
  requiredFeatures.kvm = false;
  globalTimeout = 600;
  nodes.machine = { ... }: {
    imports = [ ./service-module.nix ];
    services.scribyra-sync = {
      enable = true;
      package = service;
      inherit configFile;
      # Defaults: a local PostgreSQL database over peer authentication, filesystem blobs.
    };
    environment.systemPackages = [ pkgs.curl ];
    virtualisation.memorySize = 1024;
    virtualisation.graphics = false;
  };
  testScript = ''
    machine.start()
    machine.wait_for_unit("postgresql.service")
    machine.wait_for_unit("scribyra-sync.service")
    machine.wait_for_open_port(8787)
    machine.succeed("curl -fsS http://127.0.0.1:8787/health")
    machine.succeed("curl -fsS http://127.0.0.1:8787/ready")
    machine.succeed("printf '${bytes}' | curl -fsS -X PUT -H 'Authorization: Bearer ${bearer}' --data-binary @- http://127.0.0.1:8787${object}")
    assert machine.succeed("curl -fsS -H 'Authorization: Bearer ${bearer}' http://127.0.0.1:8787${object}") == "${bytes}"
    assert machine.succeed("runuser -u postgres -- psql -d scribyra-sync -tAc 'SELECT count(*) FROM objects'").strip() == "1"
    machine.succeed("test -f /var/lib/scribyra-sync/objects/${namespace}/${builtins.hashString "sha256" bytes}")
    machine.succeed("systemctl stop scribyra-sync.service")
    machine.succeed("${verify}")
    machine.succeed("systemctl restart postgresql.service")
    machine.succeed("systemctl start scribyra-sync.service")
    machine.wait_for_unit("scribyra-sync.service")
    machine.wait_for_open_port(8787)
    machine.succeed("curl -fsS http://127.0.0.1:8787/ready")
    assert machine.succeed("curl -fsS -H 'Authorization: Bearer ${bearer}' http://127.0.0.1:8787${object}") == "${bytes}"
  '';
}
