-- Audit retention kept in the database (review H2: `audit_purge` deleted whatever cutoff a caller
-- named, `audit_purge(now() + '1 second')` the whole log). Append-only: never edit an applied file.

-- How long events are kept. The service stores its configured retention at every start
-- (`audit_set_retention`), never below `floor_seconds`: 30 days, which the service cannot lower
-- (only the owner of the audit tables or a superuser can; the tests do, to purge within
-- seconds). A purge deletes only events older than the retention.
CREATE TABLE audit_settings (
    id boolean PRIMARY KEY DEFAULT true CHECK (id),
    retention_seconds bigint NOT NULL CHECK (retention_seconds > 0),
    floor_seconds bigint NOT NULL CHECK (floor_seconds >= 0)
);
INSERT INTO audit_settings (retention_seconds, floor_seconds) VALUES (400 * 86400, 30 * 86400);

-- Stores the configured retention (raised to the floor) and returns what is in force.
CREATE FUNCTION audit_set_retention(p_seconds bigint)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
    r bigint;
BEGIN
    UPDATE audit_settings SET retention_seconds = greatest(p_seconds, floor_seconds, 1) WHERE id RETURNING retention_seconds INTO r;
    RETURN r;
END $$;

-- Retention: deletes the events older than `p_before` (a prefix of the chain, since times never
-- decrease) and appends `audit.purge` with how many, the last purged event's sequence number and
-- hash (from which `audit verify` checks the rest), the cutoff and the retention in force. A
-- cutoff newer than now minus the retention is refused. Returns how many were deleted.
CREATE OR REPLACE FUNCTION audit_purge(p_before timestamptz)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
    keep bigint;
    last_seq bigint;
    last_hash text;
    n bigint;
BEGIN
    PERFORM 1 FROM audit_head WHERE id FOR UPDATE;
    SELECT greatest(retention_seconds, floor_seconds) INTO keep FROM audit_settings WHERE id;
    IF p_before IS NULL OR p_before > now() - make_interval(secs => keep) THEN
        RAISE EXCEPTION 'audit events are kept % seconds; a purge cannot delete newer ones', keep USING ERRCODE = 'insufficient_privilege';
    END IF;
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
        jsonb_build_object('count', n, 'last_seq', last_seq, 'last_hash', last_hash, 'before', floor(extract(epoch FROM p_before) * 1000)::bigint, 'retention', keep));
    RETURN n;
END $$;

-- The retention task's purge: everything older than the retention in force.
CREATE FUNCTION audit_purge_expired()
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
    keep bigint;
BEGIN
    SELECT greatest(retention_seconds, floor_seconds) INTO keep FROM audit_settings WHERE id;
    RETURN audit_purge(now() - make_interval(secs => keep));
END $$;
