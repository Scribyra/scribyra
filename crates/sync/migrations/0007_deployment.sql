-- Deployments (org-sync slice 8): one organisation per deployment, OpenID Connect providers from
-- the configuration file, and no sign-in of the service's own. Append-only: never edit an
-- applied file.

-- The deployment's fixed facts, written at first start: its encryption mode (the service refuses
-- to start when the configuration later names the other one) and the organisation it serves.
CREATE TABLE deployment (
    id boolean PRIMARY KEY DEFAULT true CHECK (id),
    encryption text NOT NULL CHECK (encryption IN ('server', 'e2ee')),
    org text NOT NULL REFERENCES orgs (org),
    created timestamptz NOT NULL DEFAULT now()
);

-- Setup codes are gone: a genesis is accepted from a configured administrator's sign-in.
ALTER TABLE orgs ALTER COLUMN enrol DROP NOT NULL;
-- Organisation-managed mode is gone with its sealed service keys.
ALTER TABLE orgs DROP COLUMN service_key;
ALTER TABLE orgs DROP COLUMN service_key_sealed;

-- Link-code device links are gone; device requests made through single sign-on stay.
DELETE FROM device_links WHERE request IS NULL OR request ->> 'via' IS DISTINCT FROM 'sso';

-- Providers come from the configuration file; per-organisation settings are gone. Logins name
-- the configured provider that issued them, and whether the provider marked a guest account.
DROP TABLE org_sso;
ALTER TABLE sso_logins ADD COLUMN provider text;
ALTER TABLE sso_logins ADD COLUMN guest boolean NOT NULL DEFAULT false;
-- Logins from before providers were configured cannot be attributed to one.
UPDATE sso_logins SET revoked = true WHERE provider IS NULL;
CREATE INDEX sso_logins_provider ON sso_logins (provider, checked) WHERE NOT revoked AND refresh_token IS NOT NULL;
