-- Identity, organisations and roles come from the provider (design section 3, Paul's decision 9
-- of 19 November 2026). Append-only: never edit an applied file.
--
-- An account is (issuer, subject) with a profile copied from the provider at each sign-in and
-- refresh; deployment roles are per organisation (`memberships`), recomputed from every token;
-- the configuration's administrator lists and administrators' grants are gone. Server-readable
-- projects belong to one organisation each.
--
-- This branch has no production data: accounts, sessions and server-readable projects made
-- before are removed here (their blobs are queued for removal) and everyone signs in again.
-- End-to-end organisations and their identity links are kept.

INSERT INTO sr_garbage (blob)
    SELECT blob FROM sr_entries WHERE blob IS NOT NULL
    UNION SELECT blob FROM sr_snapshots WHERE blob IS NOT NULL
    UNION SELECT blob FROM sr_objects
    UNION SELECT b FROM compiles, unnest(ARRAY[pdf_blob, log_blob]) b WHERE b IS NOT NULL
    ON CONFLICT DO NOTHING;
DELETE FROM compile_requests;
DELETE FROM compiles;
DELETE FROM sr_projects;
DELETE FROM sso_grants;
DELETE FROM sso_logins;
DELETE FROM accounts;
UPDATE usage SET bytes = 0, objects = 0 WHERE scope = 'sr:deployment';

-- Accounts: one per (issuer, subject), whichever configured provider of that issuer signed it in
-- (`provider` is the latest). `state` is `blocked` after the provider refused a refresh token
-- (until it admits the person again); disabling and removing are per organisation now.
ALTER TABLE accounts DROP CONSTRAINT accounts_provider_subject_key;
ALTER TABLE accounts ADD CONSTRAINT accounts_issuer_subject_key UNIQUE (issuer, subject);
ALTER TABLE accounts DROP COLUMN role;
ALTER TABLE accounts DROP COLUMN guest;
ALTER TABLE accounts DROP COLUMN admin_grant;
ALTER TABLE accounts ADD COLUMN picture text;
DROP INDEX accounts_subject;

-- Organisations: (provider, organisation claim value), the claim empty for a provider whose
-- mapping names none (it has one organisation). `org` is random (64 hex digits, like end-to-end
-- organisation IDs, which in an end-to-end deployment are the same); the first one made takes
-- the deployment's recorded ID (`deployment.org`).
CREATE TABLE organisations (
    org text PRIMARY KEY CHECK (org ~ '^[0-9a-f]{64}$'),
    provider text NOT NULL,
    claim text NOT NULL,
    name text NOT NULL,
    created timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider, claim)
);

-- A person's role in an organisation, from the provider's latest token: `role` NULL when the
-- provider no longer grants one (access ends at once; their projects stay in the organisation).
-- `state` is an administrator's emergency stop (`disabled`) or removal (`removed`) there.
CREATE TABLE memberships (
    account text NOT NULL REFERENCES accounts (account) ON DELETE CASCADE,
    org text NOT NULL REFERENCES organisations (org) ON DELETE CASCADE,
    role text CHECK (role IN ('admin', 'member', 'guest')),
    state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'disabled', 'removed')),
    created timestamptz NOT NULL DEFAULT now(),
    updated timestamptz NOT NULL DEFAULT now(),
    last_seen timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account, org)
);
CREATE INDEX memberships_org ON memberships (org, role) WHERE state = 'active';

-- Sessions keep the identity they signed in with; roles are read from `memberships`.
ALTER TABLE sso_logins DROP COLUMN groups;
ALTER TABLE sso_logins DROP COLUMN guest;
ALTER TABLE sso_logins ADD COLUMN picture text;

-- Every server-readable project belongs to one organisation, and never moves.
ALTER TABLE sr_projects ADD COLUMN org text NOT NULL REFERENCES organisations (org);
DROP INDEX sr_projects_owner;
CREATE INDEX sr_projects_org ON sr_projects (org, owner) WHERE deleted IS NULL;
-- Invitations are inside their project's organisation; the provider an invitation named is gone.
ALTER TABLE sr_invitations DROP COLUMN provider;
