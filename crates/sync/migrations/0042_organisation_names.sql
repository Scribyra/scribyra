-- An organisation keeps the name its first sign-in gave it. Only a preset's organisation name,
-- which the provider itself sets (a Zitadel organisation's domain, a Keycloak alias, a Google
-- Workspace domain), updates it at later sign-ins; a generic `claims.organisation_name`, which
-- users may be able to edit at their provider, never does. An administrator's rename
-- (`PUT /v1/admin/organisation`) sets `renamed`, and then no token changes it again.
-- Append-only: never edit an applied file.
ALTER TABLE organisations ADD COLUMN renamed boolean NOT NULL DEFAULT false;
