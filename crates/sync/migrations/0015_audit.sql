-- Administration and the audit log (org-sync slice 10, design section 5). Append-only: never edit
-- an applied file.

-- The audit log: one row per security-relevant action, hash-chained. `seq` is gap-free and
-- `time` never decreases along it (both are assigned under the head row's lock, so appends from
-- every replica form one line); `actor` is an account ID or `system`; `ip` the client address
-- (the one a trusted proxy names); `detail` a small JSON object (never content, tokens or
-- emails of people other than account details). `hash` = SHA-256(prev ‖ audit_canonical(row)),
-- with `prev` the previous row's hash (64 zeros before the first). `scribyra-sync audit verify`
-- recomputes the chain outside the database.
CREATE TABLE audit_events (
    seq bigint PRIMARY KEY CHECK (seq > 0),
    time timestamptz NOT NULL,
    actor text NOT NULL CHECK (actor = 'system' OR actor ~ '^[0-9a-f]{64}$'),
    ip inet,
    action text NOT NULL CHECK (action ~ '^[a-z_]+(\.[a-z_]+)+$' AND length(action) <= 64),
    target_type text CHECK (length(target_type) <= 32),
    target_id text CHECK (length(target_id) <= 128),
    detail jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 4096),
    prev text NOT NULL CHECK (prev ~ '^[0-9a-f]{64}$'),
    hash text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX audit_events_time ON audit_events (time);
CREATE INDEX audit_events_actor ON audit_events (actor, seq);
CREATE INDEX audit_events_action ON audit_events (action, seq);
CREATE INDEX audit_events_target ON audit_events (target_type, target_id, seq);

-- The chain's head: the last sequence number, hash and time. Every append locks this one row,
-- which serialises appends across replicas; a purge keeps it.
CREATE TABLE audit_head (
    id boolean PRIMARY KEY DEFAULT true CHECK (id),
    seq bigint NOT NULL,
    hash text NOT NULL,
    time timestamptz NOT NULL
);
INSERT INTO audit_head (seq, hash, time) VALUES (0, repeat('0', 64), '-infinity');

-- The canonical text of a row that its hash covers: a JSON array of every field (time in
-- microseconds since 1970, a missing IP or target as ""), in PostgreSQL's jsonb text form.
CREATE FUNCTION audit_canonical(c_seq bigint, c_time timestamptz, c_actor text, c_ip inet, c_action text, c_target_type text, c_target_id text, c_detail jsonb)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
    SELECT jsonb_build_array(c_seq, floor(extract(epoch FROM c_time) * 1000000)::bigint, c_actor, COALESCE(host(c_ip), ''), c_action, COALESCE(c_target_type, ''), COALESCE(c_target_id, ''), c_detail)::text
$$;

-- The only way rows are written: appends one event after the head and returns its sequence
-- number. Call it last in a transaction (after the rows the action changes), so the head's lock
-- is held briefly and always taken after the others.
CREATE FUNCTION audit_append(p_actor text, p_ip inet, p_action text, p_target_type text, p_target_id text, p_detail jsonb)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
    h audit_head;
    t timestamptz;
    n bigint;
    x text;
BEGIN
    SELECT * INTO h FROM audit_head WHERE id FOR UPDATE;
    n := h.seq + 1;
    t := greatest(clock_timestamp(), h.time);
    x := encode(sha256(decode(h.hash, 'hex') || convert_to(audit_canonical(n, t, p_actor, p_ip, p_action, p_target_type, p_target_id, COALESCE(p_detail, '{}')), 'UTF8')), 'hex');
    PERFORM set_config('scribyra.audit_writer', 'append', true);
    INSERT INTO audit_events (seq, time, actor, ip, action, target_type, target_id, detail, prev, hash)
        VALUES (n, t, p_actor, p_ip, p_action, p_target_type, p_target_id, COALESCE(p_detail, '{}'), h.hash, x);
    UPDATE audit_head SET seq = n, hash = x, time = t WHERE id;
    PERFORM set_config('scribyra.audit_writer', '', true);
    RETURN n;
END $$;

-- Retention: deletes the events older than `p_before` (a prefix of the chain, since times never
-- decrease) and appends `audit.purge` with how many and the last purged event's sequence number
-- and hash, from which `audit verify` checks the rest. Returns how many were deleted.
CREATE FUNCTION audit_purge(p_before timestamptz)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
    last_seq bigint;
    last_hash text;
    n bigint;
BEGIN
    PERFORM 1 FROM audit_head WHERE id FOR UPDATE;
    SELECT max(seq) INTO last_seq FROM audit_events WHERE time < p_before;
    IF last_seq IS NULL THEN
        RETURN 0;
    END IF;
    SELECT hash INTO last_hash FROM audit_events WHERE seq = last_seq;
    PERFORM set_config('scribyra.audit_writer', 'purge', true);
    DELETE FROM audit_events WHERE seq <= last_seq;
    GET DIAGNOSTICS n = ROW_COUNT;
    PERFORM set_config('scribyra.audit_writer', '', true);
    PERFORM audit_append('system', NULL, 'audit.purge', 'audit', NULL,
        jsonb_build_object('count', n, 'last_seq', last_seq, 'last_hash', last_hash, 'before', floor(extract(epoch FROM p_before) * 1000)::bigint));
    RETURN n;
END $$;

-- Rows change only through the two functions above: a direct INSERT, any UPDATE, a DELETE
-- outside a purge, and TRUNCATE are refused. (A database superuser can still disable the
-- triggers; the hash chain is what makes that detectable.)
CREATE FUNCTION audit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' AND current_setting('scribyra.audit_writer', true) = 'append' THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' AND current_setting('scribyra.audit_writer', true) = 'purge' THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'audit_events is append-only (% refused)', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER audit_events_guard BEFORE INSERT OR UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION audit_guard();
CREATE TRIGGER audit_events_truncate BEFORE TRUNCATE ON audit_events FOR EACH STATEMENT EXECUTE FUNCTION audit_guard();
CREATE FUNCTION audit_head_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND current_setting('scribyra.audit_writer', true) = 'append' THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'audit_head changes only with an append (% refused)', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER audit_head_guard BEFORE INSERT OR UPDATE OR DELETE ON audit_head FOR EACH ROW EXECUTE FUNCTION audit_head_guard();
CREATE TRIGGER audit_head_truncate BEFORE TRUNCATE ON audit_head FOR EACH STATEMENT EXECUTE FUNCTION audit_head_guard();

-- Accounts: an administrator can make a member an administrator (`admin_grant`; the
-- configuration's `admins` and `admin_groups` make administrators too, and only they can take
-- that away), and remove an account (`removed`: sessions revoked, shares gone, owned projects
-- transferred; sign-in refused until an administrator restores it).
ALTER TABLE accounts ADD COLUMN admin_grant boolean NOT NULL DEFAULT false;
ALTER TABLE accounts DROP CONSTRAINT accounts_state_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_state_check CHECK (state IN ('active', 'disabled', 'blocked', 'removed'));

-- "Open as administrator": an administrator's read access to a project without a share, for a
-- limited time from an audited open (`project.admin_open`). Nothing reads a project as an
-- administrator without one.
CREATE TABLE sr_admin_opens (
    project text NOT NULL REFERENCES sr_projects (project) ON DELETE CASCADE,
    account text NOT NULL REFERENCES accounts (account) ON DELETE CASCADE,
    until timestamptz NOT NULL,
    PRIMARY KEY (project, account)
);
CREATE INDEX sr_admin_opens_account ON sr_admin_opens (account);
