-- Server-readable projects (org-sync slice 9): accounts from OpenID Connect sign-ins, sign-in
-- state in PostgreSQL (so any replica can finish a sign-in another one started), and projects
-- the server sequences and seals at rest. Append-only: never edit an applied file.

-- One account per (provider, subject), made at its first sign-in. `role` is recomputed from the
-- deployment's rules at every sign-in and recheck; `state` is `blocked` after the provider
-- refused the account's refresh token (a later sign-in the provider admits clears it) and
-- `disabled` when an administrator disabled it (slice 10).
CREATE TABLE accounts (
    account text PRIMARY KEY CHECK (account ~ '^[0-9a-f]{64}$'),
    provider text NOT NULL,
    issuer text NOT NULL,
    subject text NOT NULL,
    email text,
    email_verified boolean NOT NULL DEFAULT false,
    name text,
    role text NOT NULL CHECK (role IN ('admin', 'member', 'guest')),
    guest boolean NOT NULL DEFAULT false,
    state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'disabled', 'blocked')),
    created timestamptz NOT NULL DEFAULT now(),
    last_seen timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider, subject)
);
CREATE INDEX accounts_email ON accounts (lower(email)) WHERE email_verified;
CREATE INDEX accounts_subject ON accounts (issuer, subject);
-- Sessions stay in `sso_logins` (only the SHA-256 of the bearer token is stored); each names
-- its account. Logins from before accounts existed have none and must sign in again for
-- server-readable routes.
ALTER TABLE sso_logins ADD COLUMN account text REFERENCES accounts (account) ON DELETE CASCADE;
CREATE INDEX sso_logins_account ON sso_logins (account) WHERE NOT revoked;

-- Sign-ins in progress and one-time grants, formerly in one process's memory. Only hashes of
-- the state and grant codes are stored; rows live for minutes and are deleted when used.
CREATE TABLE sso_flows (
    state_hash text PRIMARY KEY CHECK (state_hash ~ '^[0-9a-f]{64}$'),
    provider text NOT NULL,
    return_to text NOT NULL,
    challenge text NOT NULL,
    nonce text NOT NULL,
    verifier text NOT NULL,
    expires timestamptz NOT NULL
);
CREATE INDEX sso_flows_expires ON sso_flows (expires);
CREATE TABLE sso_grants (
    code_hash text PRIMARY KEY CHECK (code_hash ~ '^[0-9a-f]{64}$'),
    provider text NOT NULL,
    challenge text NOT NULL,
    identity jsonb NOT NULL,
    refresh_token text,
    session_seconds bigint NOT NULL,
    expires timestamptz NOT NULL
);
CREATE INDEX sso_grants_expires ON sso_grants (expires);
-- Back-channel logout token IDs already used (replay protection across replicas).
CREATE TABLE sso_logout_jtis (
    key text PRIMARY KEY,
    expires timestamptz NOT NULL
);

-- A server-readable project. `data_key_wrapped` is the project's random data key sealed under
-- the master key (nonce ‖ ciphertext); deleting the project clears it in the same transaction
-- (crypto-erase) and a background task then removes the rows and blobs. `head_seq` is the last
-- sequenced entry, `snapshot_seq` the latest server snapshot, `floor_seq` the lowest `after` a
-- reader may ask for (entries at or below it have no body any more). `bytes` counts stored
-- (sealed) bytes of entries, snapshots and objects.
CREATE TABLE sr_projects (
    project text PRIMARY KEY CHECK (project ~ '^[0-9a-f]{64}$'),
    owner text NOT NULL REFERENCES accounts (account),
    name text NOT NULL,
    created timestamptz NOT NULL DEFAULT now(),
    updated timestamptz NOT NULL DEFAULT now(),
    deleted timestamptz,
    head_seq bigint NOT NULL DEFAULT 0,
    snapshot_seq bigint NOT NULL DEFAULT 0,
    floor_seq bigint NOT NULL DEFAULT 0,
    bytes bigint NOT NULL DEFAULT 0,
    data_key_wrapped bytea,
    compile text NOT NULL DEFAULT 'browser' CHECK (compile IN ('browser', 'server')),
    CHECK (deleted IS NOT NULL OR data_key_wrapped IS NOT NULL)
);
CREATE INDEX sr_projects_owner ON sr_projects (owner) WHERE deleted IS NULL;
CREATE INDEX sr_projects_deleted ON sr_projects (deleted) WHERE deleted IS NOT NULL;
CREATE TABLE sr_shares (
    project text NOT NULL REFERENCES sr_projects (project) ON DELETE CASCADE,
    account text NOT NULL REFERENCES accounts (account) ON DELETE CASCADE,
    role text NOT NULL CHECK (role IN ('editor', 'reviewer', 'viewer')),
    created_by text,
    created timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project, account)
);
CREATE INDEX sr_shares_account ON sr_shares (account);
CREATE TABLE sr_invitations (
    invitation text PRIMARY KEY CHECK (invitation ~ '^[0-9a-f]{64}$'),
    project text NOT NULL REFERENCES sr_projects (project) ON DELETE CASCADE,
    email text NOT NULL,
    role text NOT NULL CHECK (role IN ('editor', 'reviewer', 'viewer')),
    created_by text,
    created timestamptz NOT NULL DEFAULT now(),
    expires timestamptz NOT NULL,
    state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'accepted', 'withdrawn'))
);
CREATE UNIQUE INDEX sr_invitations_pending ON sr_invitations (project, email) WHERE state = 'pending';
CREATE INDEX sr_invitations_email ON sr_invitations (email) WHERE state = 'pending';
-- One row per sequenced entry. The body is sealed: inline (`inline_sealed`) up to
-- `entry_inline_bytes`, otherwise in the blob store under `blob`. Once the floor passes an
-- entry its body is dropped but the row stays, so a retry of its (client, client_seq) still
-- gets its original acknowledgement.
CREATE TABLE sr_entries (
    project text NOT NULL REFERENCES sr_projects (project) ON DELETE CASCADE,
    seq bigint NOT NULL CHECK (seq > 0),
    kind text NOT NULL DEFAULT 'update' CHECK (kind IN ('update')),
    account text,
    client text NOT NULL,
    client_seq bigint NOT NULL,
    body_hash text NOT NULL,
    size bigint NOT NULL,
    inline_sealed bytea,
    blob text,
    received timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project, seq),
    UNIQUE (project, client, client_seq)
);
CREATE TABLE sr_snapshots (
    project text NOT NULL REFERENCES sr_projects (project) ON DELETE CASCADE,
    seq bigint NOT NULL,
    size bigint NOT NULL,
    inline_sealed bytea,
    blob text,
    created timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project, seq)
);
-- Assets and history objects, content-addressed by the SHA-256 of their plaintext.
CREATE TABLE sr_objects (
    project text NOT NULL REFERENCES sr_projects (project) ON DELETE CASCADE,
    hash text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
    size bigint NOT NULL,
    sealed_size bigint NOT NULL,
    blob text NOT NULL,
    created timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project, hash)
);
-- Blobs of erased or compacted rows that still have to be removed from the blob store.
CREATE TABLE sr_garbage (
    blob text PRIMARY KEY,
    queued timestamptz NOT NULL DEFAULT now()
);
-- Stored (sealed) bytes of the whole deployment; locked FOR UPDATE by every charging write.
INSERT INTO usage (scope) VALUES ('sr:deployment') ON CONFLICT DO NOTHING;
