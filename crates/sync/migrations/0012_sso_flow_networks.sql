-- Review M5: sign-ins in progress also name the client's network (IPv4 /24, IPv6 /48; `source`
-- is now an IPv4 address or an IPv6 /64), so one network holds a bounded share and a full table
-- makes room from the network that holds the most. Additive. Append-only: never edit an applied
-- file.
ALTER TABLE sso_flows ADD COLUMN network text NOT NULL DEFAULT '';
CREATE INDEX sso_flows_network ON sso_flows (network, expires);
