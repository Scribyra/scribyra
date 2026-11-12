{ pkgs, service }:
let
  bearer = pkgs.lib.concatStrings (pkgs.lib.replicate 64 "1");
  namespace = pkgs.lib.concatStrings (pkgs.lib.replicate 64 "2");
  bytes = "opaque-service-vm-fixture";
  object = "/v1/objects/${namespace}/${builtins.hashString "sha256" bytes}";
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
      configFile = pkgs.writeText "service-test.json" (builtins.toJSON {
        principals = [{
          token_hash = builtins.hashString "sha256" bearer;
          inherit namespace;
          storage = true;
          relay = true;
        }];
      });
    };
    environment.systemPackages = [ pkgs.curl ];
    virtualisation.memorySize = 1024;
    virtualisation.graphics = false;
  };
  testScript = ''
    machine.start()
    machine.wait_for_unit("scribyra-sync.service")
    machine.wait_for_open_port(8787)
    machine.succeed("curl -fsS http://127.0.0.1:8787/health")
    machine.succeed("curl -fsS http://127.0.0.1:8787/ready")
    machine.succeed("printf '${bytes}' | curl -fsS -X PUT -H 'Authorization: Bearer ${bearer}' --data-binary @- http://127.0.0.1:8787${object}")
    assert machine.succeed("curl -fsS -H 'Authorization: Bearer ${bearer}' http://127.0.0.1:8787${object}") == "${bytes}"
    machine.succeed("systemctl restart scribyra-sync.service")
    machine.wait_for_unit("scribyra-sync.service")
    machine.wait_for_open_port(8787)
    machine.succeed("curl -fsS http://127.0.0.1:8787/ready")
    assert machine.succeed("curl -fsS -H 'Authorization: Bearer ${bearer}' http://127.0.0.1:8787${object}") == "${bytes}"
  '';
}
