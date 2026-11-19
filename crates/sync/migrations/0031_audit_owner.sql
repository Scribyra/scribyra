-- The audit tables belong to a role of their own (review M1). Append-only: never edit an applied
-- file.
--
-- Before, the triggers let a row change when the session setting `scribyra.audit_writer` said
-- so, which any session can set, and the service's database user owned the tables, so it could
-- also disable the triggers. Now the NOLOGIN role `scribyra_audit_owner` owns the audit tables
-- and the functions that write them (SECURITY DEFINER, with a fixed search_path); the service's
-- user keeps SELECT on the tables and EXECUTE on the functions, nothing else, and the triggers
-- let only the tables' owner (that is: those functions) insert, delete or move the head.
--
-- `audit_protect()` hands the tables over. It needs a database user that is a superuser, has
-- CREATEROLE (it then creates the role, briefly grants itself SET on it, and revokes that), or
-- can SET ROLE to an existing `scribyra_audit_owner` (an operator's grant, to revoke afterwards).
-- Otherwise the tables stay the service's (as before, only the hash chain and exported heads
-- protect them) and it says why. It runs here and at every start of `serve` and `migrate`, which
-- report the result (docs/service.md). A database superuser can still change anything; the hash
-- chain and exported heads are what detect that.

CREATE OR REPLACE FUNCTION audit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP IN ('INSERT', 'DELETE') AND (SELECT relowner FROM pg_catalog.pg_class WHERE oid = TG_RELID) = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user) THEN
        RETURN CASE TG_OP WHEN 'INSERT' THEN NEW ELSE OLD END;
    END IF;
    RAISE EXCEPTION 'audit_events is append-only (% refused)', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE OR REPLACE FUNCTION audit_head_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND (SELECT relowner FROM pg_catalog.pg_class WHERE oid = TG_RELID) = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user) THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'audit_head changes only with an append (% refused)', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE OR REPLACE FUNCTION audit_append(p_actor text, p_ip inet, p_action text, p_target_type text, p_target_id text, p_detail jsonb)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER AS $$
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
    INSERT INTO audit_events (seq, time, actor, ip, action, target_type, target_id, detail, prev, hash)
        VALUES (n, t, p_actor, p_ip, p_action, p_target_type, p_target_id, COALESCE(p_detail, '{}'), h.hash, x);
    UPDATE audit_head SET seq = n, hash = x, time = t WHERE id;
    RETURN n;
END $$;

CREATE OR REPLACE FUNCTION audit_purge(p_before timestamptz)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER AS $$
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
    DELETE FROM audit_events WHERE seq <= last_seq;
    GET DIAGNOSTICS n = ROW_COUNT;
    PERFORM audit_append('system', NULL, 'audit.purge', 'audit', NULL,
        jsonb_build_object('count', n, 'last_seq', last_seq, 'last_hash', last_hash, 'before', floor(extract(epoch FROM p_before) * 1000)::bigint, 'retention', keep));
    RETURN n;
END $$;
ALTER FUNCTION audit_purge_expired() SECURITY DEFINER;
ALTER FUNCTION audit_set_retention(bigint) SECURITY DEFINER;

-- The definer functions resolve names only in this schema (then pg_temp, last), never in a
-- schema a session could put first.
DO $$
BEGIN
    EXECUTE format('ALTER FUNCTION audit_append(text, inet, text, text, text, jsonb) SET search_path = %I, pg_temp', current_schema());
    EXECUTE format('ALTER FUNCTION audit_purge(timestamptz) SET search_path = %I, pg_temp', current_schema());
    EXECUTE format('ALTER FUNCTION audit_purge_expired() SET search_path = %I, pg_temp', current_schema());
    EXECUTE format('ALTER FUNCTION audit_set_retention(bigint) SET search_path = %I, pg_temp', current_schema());
END $$;

-- Hands the audit tables and functions to `scribyra_audit_owner` where this database user can,
-- and returns the outcome: `protected`, `protected; reachable: …` (this user can still become
-- the owner: a superuser, or a member of the role), or `unprotected: …`. Idempotent.
CREATE FUNCTION audit_protect() RETURNS text LANGUAGE plpgsql AS $$
DECLARE
    me text := current_user;
    super boolean := (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user);
    dba text := (SELECT pg_catalog.pg_get_userbyid(datdba) FROM pg_catalog.pg_database WHERE datname = current_database());
    granted boolean := false;
    schema_granted boolean := false;
    owner_oid oid;
    item text;
    tables constant text[] := ARRAY['audit_events', 'audit_head', 'audit_settings'];
    functions constant text[] := ARRAY['audit_append(text, inet, text, text, text, jsonb)', 'audit_purge(timestamptz)', 'audit_purge_expired()', 'audit_set_retention(bigint)', 'audit_canonical(bigint, timestamptz, text, inet, text, text, text, jsonb)', 'audit_guard()', 'audit_head_guard()'];
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
