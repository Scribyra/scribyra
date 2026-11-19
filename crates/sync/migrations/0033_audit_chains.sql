-- One audit chain per organisation (design sections 3 and 5): an organisation's administrators
-- read and export their organisation's chain only, and `audit verify --org` checks one. Append-only:
-- never edit an applied file.
--
-- The chains live in new tables, made here by the migrating user and then handed to
-- `scribyra_audit_owner` by `audit_protect()` exactly as migration 0031 did for the first ones,
-- so this migration needs no rights over the protected tables. `audit_log` holds every chain,
-- keyed by organisation (`org`, 64 hex digits) and gap-free `seq` within it; the empty `org` is the
-- deployment's own chain (service starts, purges of it, sign-ins refused before an organisation
-- is known). The events of the single chain before (`audit_events`) are copied into the
-- deployment chain unchanged, so their hashes still verify; `audit_events` and `audit_head` stay
-- as they were, protected and no longer written.
--
-- An organisation's events also cover the organisation: hash = SHA-256(prev ‖ canonical row),
-- the canonical row as before with the organisation's ID appended (the deployment chain's rows
-- keep the old form).

CREATE TABLE audit_log (
    org text NOT NULL CHECK (org = '' OR org ~ '^[0-9a-f]{64}$'),
    seq bigint NOT NULL CHECK (seq > 0),
    time timestamptz NOT NULL,
    actor text NOT NULL CHECK (actor = 'system' OR actor ~ '^[0-9a-f]{64}$'),
    ip inet,
    action text NOT NULL CHECK (action ~ '^[a-z_]+(\.[a-z_]+)+$' AND length(action) <= 64),
    target_type text CHECK (length(target_type) <= 32),
    target_id text CHECK (length(target_id) <= 128),
    detail jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 4096),
    prev text NOT NULL CHECK (prev ~ '^[0-9a-f]{64}$'),
    hash text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
    PRIMARY KEY (org, seq)
);
CREATE INDEX audit_log_time ON audit_log (time);
CREATE INDEX audit_log_actor ON audit_log (org, actor, seq);
CREATE INDEX audit_log_action ON audit_log (org, action, seq);
CREATE INDEX audit_log_target ON audit_log (org, target_type, target_id, seq);
-- Each chain's head; an append locks its chain's row only.
CREATE TABLE audit_heads (
    org text PRIMARY KEY CHECK (org = '' OR org ~ '^[0-9a-f]{64}$'),
    seq bigint NOT NULL,
    hash text NOT NULL,
    time timestamptz NOT NULL
);
INSERT INTO audit_log (org, seq, time, actor, ip, action, target_type, target_id, detail, prev, hash)
    SELECT '', seq, time, actor, ip, action, target_type, target_id, detail, prev, hash FROM audit_events;
INSERT INTO audit_heads (org, seq, hash, time) SELECT '', seq, hash, time FROM audit_head;

CREATE FUNCTION audit_log_canonical(c_org text, c_seq bigint, c_time timestamptz, c_actor text, c_ip inet, c_action text, c_target_type text, c_target_id text, c_detail jsonb)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN c_org = ''
        THEN jsonb_build_array(c_seq, floor(extract(epoch FROM c_time) * 1000000)::bigint, c_actor, COALESCE(host(c_ip), ''), c_action, COALESCE(c_target_type, ''), COALESCE(c_target_id, ''), c_detail)::text
        ELSE jsonb_build_array(c_seq, floor(extract(epoch FROM c_time) * 1000000)::bigint, c_actor, COALESCE(host(c_ip), ''), c_action, COALESCE(c_target_type, ''), COALESCE(c_target_id, ''), c_detail, c_org)::text
    END
$$;

-- Appends one event to an organisation's chain (made at its first event) and returns its
-- sequence number. Call it last in a transaction, as before.
CREATE FUNCTION audit_log_append(p_org text, p_actor text, p_ip inet, p_action text, p_target_type text, p_target_id text, p_detail jsonb)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    h audit_heads;
    t timestamptz;
    n bigint;
    x text;
BEGIN
    INSERT INTO audit_heads (org, seq, hash, time) VALUES (p_org, 0, repeat('0', 64), '-infinity') ON CONFLICT (org) DO NOTHING;
    SELECT * INTO h FROM audit_heads WHERE org = p_org FOR UPDATE;
    n := h.seq + 1;
    t := greatest(clock_timestamp(), h.time);
    x := encode(sha256(decode(h.hash, 'hex') || convert_to(audit_log_canonical(p_org, n, t, p_actor, p_ip, p_action, p_target_type, p_target_id, COALESCE(p_detail, '{}')), 'UTF8')), 'hex');
    INSERT INTO audit_log (org, seq, time, actor, ip, action, target_type, target_id, detail, prev, hash)
        VALUES (p_org, n, t, p_actor, p_ip, p_action, p_target_type, p_target_id, COALESCE(p_detail, '{}'), h.hash, x);
    UPDATE audit_heads SET seq = n, hash = x, time = t WHERE org = p_org;
    RETURN n;
END $$;

-- Retention for every chain: deletes each chain's events older than `p_before` (a prefix, since
-- times never decrease along a chain) and appends `audit.purge` to that chain, as in 0030. A
-- cutoff newer than now minus the retention is refused. Returns how many were deleted in all.
CREATE FUNCTION audit_log_purge(p_before timestamptz)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    keep bigint;
    chain text;
    last_seq bigint;
    last_hash text;
    n bigint;
    total bigint := 0;
BEGIN
    SELECT greatest(retention_seconds, floor_seconds) INTO keep FROM audit_settings WHERE id;
    IF p_before IS NULL OR p_before > now() - make_interval(secs => keep) THEN
        RAISE EXCEPTION 'audit events are kept % seconds; a purge cannot delete newer ones', keep USING ERRCODE = 'insufficient_privilege';
    END IF;
    FOR chain IN SELECT org FROM audit_heads ORDER BY org FOR UPDATE LOOP
        SELECT max(seq) INTO last_seq FROM audit_log WHERE org = chain AND time < p_before;
        CONTINUE WHEN last_seq IS NULL;
        SELECT hash INTO last_hash FROM audit_log WHERE org = chain AND seq = last_seq;
        DELETE FROM audit_log WHERE org = chain AND seq <= last_seq;
        GET DIAGNOSTICS n = ROW_COUNT;
        total := total + n;
        PERFORM audit_log_append(chain, 'system', NULL, 'audit.purge', 'audit', NULL,
            jsonb_build_object('count', n, 'last_seq', last_seq, 'last_hash', last_hash, 'before', floor(extract(epoch FROM p_before) * 1000)::bigint, 'retention', keep));
    END LOOP;
    RETURN total;
END $$;
CREATE FUNCTION audit_log_purge_expired()
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    keep bigint;
BEGIN
    SELECT greatest(retention_seconds, floor_seconds) INTO keep FROM audit_settings WHERE id;
    RETURN audit_log_purge(now() - make_interval(secs => keep));
END $$;

-- Only the tables' owner (the functions above) inserts or deletes rows or moves a head.
CREATE FUNCTION audit_log_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP IN ('INSERT', 'DELETE') AND (SELECT relowner FROM pg_catalog.pg_class WHERE oid = TG_RELID) = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user) THEN
        RETURN CASE TG_OP WHEN 'INSERT' THEN NEW ELSE OLD END;
    END IF;
    RAISE EXCEPTION 'audit_log is append-only (% refused)', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE FUNCTION audit_log_head_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP IN ('INSERT', 'UPDATE') AND (SELECT relowner FROM pg_catalog.pg_class WHERE oid = TG_RELID) = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user) THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'audit_heads change only with an append (% refused)', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER audit_log_guard BEFORE INSERT OR UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_guard();
CREATE TRIGGER audit_log_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION audit_log_guard();
CREATE TRIGGER audit_heads_guard BEFORE INSERT OR UPDATE OR DELETE ON audit_heads FOR EACH ROW EXECUTE FUNCTION audit_log_head_guard();
CREATE TRIGGER audit_heads_truncate BEFORE TRUNCATE ON audit_heads FOR EACH STATEMENT EXECUTE FUNCTION audit_log_head_guard();

DO $$
BEGIN
    EXECUTE format('ALTER FUNCTION audit_log_append(text, text, inet, text, text, text, jsonb) SET search_path = %I, pg_temp', current_schema());
    EXECUTE format('ALTER FUNCTION audit_log_purge(timestamptz) SET search_path = %I, pg_temp', current_schema());
    EXECUTE format('ALTER FUNCTION audit_log_purge_expired() SET search_path = %I, pg_temp', current_schema());
END $$;

-- audit_protect() (0031) with the new tables and functions in its lists.
CREATE OR REPLACE FUNCTION audit_protect() RETURNS text LANGUAGE plpgsql AS $$
DECLARE
    me text := current_user;
    super boolean := (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user);
    dba text := (SELECT pg_catalog.pg_get_userbyid(datdba) FROM pg_catalog.pg_database WHERE datname = current_database());
    granted boolean := false;
    schema_granted boolean := false;
    owner_oid oid;
    item text;
    tables constant text[] := ARRAY['audit_events', 'audit_head', 'audit_settings', 'audit_log', 'audit_heads'];
    functions constant text[] := ARRAY['audit_append(text, inet, text, text, text, jsonb)', 'audit_purge(timestamptz)', 'audit_purge_expired()', 'audit_set_retention(bigint)', 'audit_canonical(bigint, timestamptz, text, inet, text, text, text, jsonb)', 'audit_guard()', 'audit_head_guard()',
        'audit_log_append(text, text, inet, text, text, text, jsonb)', 'audit_log_purge(timestamptz)', 'audit_log_purge_expired()', 'audit_log_canonical(text, bigint, timestamptz, text, inet, text, text, text, jsonb)', 'audit_log_guard()', 'audit_log_head_guard()'];
    readers text[] := ARRAY[]::text[];
    reach text;
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'scribyra_audit_owner') THEN
        BEGIN
            CREATE ROLE scribyra_audit_owner NOLOGIN;
        EXCEPTION
            WHEN duplicate_object OR unique_violation THEN NULL;
            WHEN insufficient_privilege THEN
                RETURN 'unprotected: the role scribyra_audit_owner does not exist and this database user cannot create it';
        END;
    END IF;
    owner_oid := (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'scribyra_audit_owner');
    IF EXISTS (SELECT FROM unnest(tables) t WHERE (SELECT relowner FROM pg_catalog.pg_class WHERE oid = t::regclass) <> owner_oid)
       OR EXISTS (SELECT FROM unnest(functions) f WHERE (SELECT proowner FROM pg_catalog.pg_proc WHERE oid = f::regprocedure) <> owner_oid) THEN
      BEGIN
        IF NOT super AND NOT pg_catalog.pg_has_role(me, owner_oid, 'SET') THEN
            IF pg_catalog.pg_has_role(me, owner_oid, 'SET WITH ADMIN OPTION') THEN
                EXECUTE format('GRANT scribyra_audit_owner TO %I WITH INHERIT FALSE, SET TRUE', me);
                granted := true;
            ELSE
                RETURN 'unprotected: this database user can neither create the role scribyra_audit_owner nor SET ROLE to it';
            END IF;
        END IF;
        -- A new owner needs CREATE on the schema (only while ownership passes).
        IF NOT super AND NOT pg_catalog.has_schema_privilege(owner_oid, current_schema(), 'CREATE') THEN
            EXECUTE format('GRANT CREATE ON SCHEMA %I TO scribyra_audit_owner', current_schema());
            schema_granted := true;
        END IF;
        FOREACH item IN ARRAY tables LOOP
            IF (SELECT relowner FROM pg_catalog.pg_class WHERE oid = item::regclass) <> owner_oid THEN
                EXECUTE format('ALTER TABLE %s OWNER TO scribyra_audit_owner', item::regclass);
            END IF;
        END LOOP;
        FOREACH item IN ARRAY functions LOOP
            IF (SELECT proowner FROM pg_catalog.pg_proc WHERE oid = item::regprocedure) <> owner_oid THEN
                EXECUTE format('ALTER FUNCTION %s OWNER TO scribyra_audit_owner', item::regprocedure);
            END IF;
        END LOOP;
        IF schema_granted THEN
            EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM scribyra_audit_owner', current_schema());
        END IF;
        -- As the owner: the service's user (and the database's owner) read the tables and call the
        -- functions; nobody else, and nobody writes the tables directly.
        IF NOT super THEN
            readers := readers || me;
        END IF;
        IF dba IS NOT NULL AND NOT (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = dba) AND dba <> ALL (readers) THEN
            readers := readers || dba;
        END IF;
        EXECUTE 'SET ROLE scribyra_audit_owner';
        FOREACH item IN ARRAY tables LOOP
            EXECUTE format('REVOKE ALL ON %s FROM PUBLIC', item::regclass);
        END LOOP;
        FOREACH item IN ARRAY functions LOOP
            EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', item::regprocedure);
        END LOOP;
        FOREACH reach IN ARRAY readers LOOP
            FOREACH item IN ARRAY tables LOOP
                EXECUTE format('REVOKE ALL ON %s FROM %I', item::regclass, reach);
                EXECUTE format('GRANT SELECT ON %s TO %I', item::regclass, reach);
            END LOOP;
            FOREACH item IN ARRAY functions LOOP
                EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', item::regprocedure, reach);
            END LOOP;
        END LOOP;
        EXECUTE 'RESET ROLE';
        IF granted THEN
            EXECUTE format('REVOKE scribyra_audit_owner FROM %I', me);
        END IF;
      EXCEPTION WHEN insufficient_privilege THEN
        -- Everything in this block is undone.
        RETURN 'unprotected: ' || SQLERRM;
      END;
    END IF;
    reach := CASE
        WHEN super THEN 'this database user is a superuser'
        WHEN pg_catalog.pg_has_role(me, owner_oid, 'SET') OR pg_catalog.pg_has_role(me, owner_oid, 'USAGE') THEN 'this database user is a member of scribyra_audit_owner'
        WHEN pg_catalog.pg_has_role(me, owner_oid, 'SET WITH ADMIN OPTION') THEN 'this database user can grant itself scribyra_audit_owner (it created the role)'
    END;
    RETURN CASE WHEN reach IS NULL THEN 'protected' ELSE 'protected; reachable: ' || reach END;
END $$;
SELECT audit_protect();
