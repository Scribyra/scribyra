-- Sign-ins in progress name the client address that started them, so one source cannot fill the
-- table and lock everyone else out (review M2): each source holds a few, and a full table makes
-- room by dropping the oldest. Append-only: never edit an applied file.
ALTER TABLE sso_flows ADD COLUMN source text NOT NULL DEFAULT '';
CREATE INDEX sso_flows_source ON sso_flows (source, expires);
