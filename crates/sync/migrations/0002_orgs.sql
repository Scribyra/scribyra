-- Organisation sync, slice 1 (docs/org-sync-design.md). Append-only: never edit an applied file.

-- One row per organisation. `enrol` is the Ed25519 public key derived from the single-use setup
-- secret printed by `scribyra-sync org create`; the secret itself is never stored.
CREATE TABLE orgs (
    org text PRIMARY KEY CHECK (org ~ '^[0-9a-f]{64}$'),
    label text NOT NULL,
    enrol text NOT NULL CHECK (enrol ~ '^[0-9a-f]{64}$'),
    created timestamptz NOT NULL DEFAULT now()
);

-- The signed, hash-chained membership log, exactly as clients signed it (canonical JSON).
CREATE TABLE org_events (
    org text NOT NULL REFERENCES orgs (org) ON DELETE CASCADE,
    seq bigint NOT NULL CHECK (seq >= 1),
    hash text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
    raw text NOT NULL,
    received timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (org, seq),
    UNIQUE (org, hash)
);

-- Project keys wrapped to member keys. The service cannot open them.
CREATE TABLE wraps (
    org text NOT NULL REFERENCES orgs (org) ON DELETE CASCADE,
    project text NOT NULL CHECK (project ~ '^[0-9a-f]{64}$'),
    epoch integer NOT NULL CHECK (epoch >= 1),
    recipient text NOT NULL CHECK (recipient ~ '^[0-9a-f]{64}$'),
    raw text NOT NULL,
    received timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (org, project, epoch, recipient)
);

-- One append-only log per project; the row lock serialises appends.
CREATE TABLE projects (
    project text PRIMARY KEY CHECK (project ~ '^[0-9a-f]{64}$'),
    org text NOT NULL REFERENCES orgs (org) ON DELETE CASCADE,
    epoch integer NOT NULL CHECK (epoch >= 1),
    head_seq bigint NOT NULL DEFAULT 0 CHECK (head_seq >= 0),
    head_chain text NOT NULL CHECK (head_chain ~ '^[0-9a-f]{64}$'),
    bytes bigint NOT NULL DEFAULT 0 CHECK (bytes >= 0)
);
CREATE INDEX projects_org ON projects (org);

-- Encrypted entries. `inline` holds small bodies; larger ones are blobs `entries/<project>/<hash>`
-- made durable before this row commits.
CREATE TABLE entries (
    project text NOT NULL REFERENCES projects (project) ON DELETE CASCADE,
    seq bigint NOT NULL CHECK (seq >= 1),
    device text NOT NULL CHECK (device ~ '^[0-9a-f]{64}$'),
    client_seq bigint NOT NULL CHECK (client_seq >= 1),
    epoch integer NOT NULL CHECK (epoch >= 1),
    entry_hash text NOT NULL CHECK (entry_hash ~ '^[0-9a-f]{64}$'),
    chain text NOT NULL CHECK (chain ~ '^[0-9a-f]{64}$'),
    size bigint NOT NULL CHECK (size > 0),
    inline bytea,
    received timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project, seq),
    UNIQUE (project, device, client_seq)
);
