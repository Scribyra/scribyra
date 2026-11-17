-- Organisations with an encryption mode, invitations and device linking (org-sync slices 2-5).
-- Append-only: never edit an applied file.

-- The service's X25519 key for an organisation, used only if its owner chooses
-- organisation-managed encryption at genesis. The secret is sealed under the operator's
-- master key file (`service_key_file`), never stored in the clear.
ALTER TABLE orgs ADD COLUMN service_key text CHECK (service_key ~ '^[0-9a-f]{64}$');
ALTER TABLE orgs ADD COLUMN service_key_sealed bytea;

-- One-time device links: an existing device registers the public half of a link key; the new
-- device's request (signed with that key and its own) waits here until a device of the same
-- person approves it with a signed device.add. Nothing here grants access by itself.
CREATE TABLE device_links (
    org text NOT NULL REFERENCES orgs (org) ON DELETE CASCADE,
    link text NOT NULL CHECK (link ~ '^[0-9a-f]{32}$'),
    person text NOT NULL,
    link_key text NOT NULL CHECK (link_key ~ '^[0-9a-f]{64}$'),
    expires timestamptz NOT NULL,
    request jsonb,
    PRIMARY KEY (org, link)
);
CREATE INDEX device_links_person ON device_links (org, person);

-- Wraps are kept per sender, so a member who uploads a wrong key for someone cannot overwrite a
-- good one; a recipient that cannot open a wrap reports it and the service drops it, which lists
-- the recipient as missing again for honest members' apps.
ALTER TABLE wraps ADD COLUMN sender text;
UPDATE wraps SET sender = raw::jsonb ->> 'sender';
ALTER TABLE wraps ALTER COLUMN sender SET NOT NULL;
ALTER TABLE wraps ADD CONSTRAINT wraps_sender CHECK (sender ~ '^[0-9a-f]{64}$');
ALTER TABLE wraps DROP CONSTRAINT wraps_pkey;
ALTER TABLE wraps ADD PRIMARY KEY (org, project, epoch, recipient, sender);
