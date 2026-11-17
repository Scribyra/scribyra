-- Milestone S objects in PostgreSQL. Migrations are append-only: never edit an applied file.
-- Immutable opaque objects. `namespace` is a capability namespace (or, later, a project ID);
-- `hash` is the SHA-256 of the opaque bytes. A row exists only after its blob is durable.
CREATE TABLE objects (
    namespace text NOT NULL CHECK (namespace ~ '^[A-Za-z0-9_-]{1,128}$'),
    hash text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
    size bigint NOT NULL CHECK (size >= 0),
    created timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (namespace, hash)
);

-- Charged usage per quota scope: 'global', 'namespace:<id>' (later 'org:<id>').
-- Writers lock the rows they charge FOR UPDATE in a fixed order (global first), check the
-- quota, and update usage in the same transaction as the object insert.
CREATE TABLE usage (
    scope text PRIMARY KEY,
    bytes bigint NOT NULL DEFAULT 0 CHECK (bytes >= 0),
    objects bigint NOT NULL DEFAULT 0 CHECK (objects >= 0)
);
INSERT INTO usage (scope) VALUES ('global');
