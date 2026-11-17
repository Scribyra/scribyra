-- Single sign-on (OIDC relying party) per organisation. Append-only: never edit an applied file.

-- One identity provider per organisation, set with `scribyra-sync org sso`. `client_secret` is
-- the confidential client's secret in plain text: the service must present it to the token
-- endpoint, so protect database access and backups accordingly.
CREATE TABLE org_sso (
    org text PRIMARY KEY REFERENCES orgs (org) ON DELETE CASCADE,
    issuer text NOT NULL,
    client_id text NOT NULL,
    client_secret text NOT NULL,
    required boolean NOT NULL DEFAULT false,
    email_domain text,
    groups_claim text,
    session_seconds integer NOT NULL DEFAULT 43200 CHECK (session_seconds BETWEEN 60 AND 2592000),
    recheck_seconds integer NOT NULL DEFAULT 600 CHECK (recheck_seconds BETWEEN 1 AND 86400),
    scopes text NOT NULL DEFAULT 'openid email profile',
    -- People added at or before this membership log position (when SSO was first configured)
    -- may be linked to an SSO identity on first sign-in; everyone later links when joining.
    linked_before bigint NOT NULL DEFAULT 0
);

-- Signed-in SSO identities. Only SHA-256 of the bearer token is stored. `refresh_token` is the
-- identity provider's refresh token (plain text), used by the background recheck.
CREATE TABLE sso_logins (
    token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    org text NOT NULL REFERENCES orgs (org) ON DELETE CASCADE,
    issuer text NOT NULL,
    subject text NOT NULL,
    email text,
    email_verified boolean NOT NULL DEFAULT false,
    name text,
    groups jsonb NOT NULL DEFAULT '[]',
    sid text,
    refresh_token text,
    created timestamptz NOT NULL DEFAULT now(),
    expires timestamptz NOT NULL,
    checked timestamptz NOT NULL DEFAULT now(),
    revoked boolean NOT NULL DEFAULT false
);
CREATE INDEX sso_logins_subject ON sso_logins (org, issuer, subject);
CREATE INDEX sso_logins_recheck ON sso_logins (checked) WHERE NOT revoked AND refresh_token IS NOT NULL;

-- An identity provider subject bound to one person of the organisation. `blocked` is set when
-- the provider refuses the person's refresh token; only unlinking clears it.
CREATE TABLE sso_links (
    org text NOT NULL REFERENCES orgs (org) ON DELETE CASCADE,
    issuer text NOT NULL,
    subject text NOT NULL,
    person text NOT NULL CHECK (person ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    email text,
    state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'blocked')),
    linked timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (org, issuer, subject),
    UNIQUE (org, person)
);
