-- Encrypted project objects (org-sync slice 6): binary assets and history checkpoint objects.
-- Append-only: never edit an applied file.
--
-- The bytes live in `objects` under the namespace `p-<project>`, content-addressed by the SHA-256
-- of the ciphertext (so the existing verification, quotas and blob layout apply). This table maps
-- the client's keyed object ID (an HMAC under the project's object-ID key, never a plaintext
-- hash) to that ciphertext. An ID is written once: a second upload must carry the same bytes.
CREATE TABLE project_objects (
    project text NOT NULL REFERENCES projects (project) ON DELETE CASCADE,
    id text NOT NULL CHECK (id ~ '^[0-9a-f]{64}$'),
    epoch integer NOT NULL CHECK (epoch >= 1),
    hash text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
    size bigint NOT NULL CHECK (size >= 0),
    device text NOT NULL CHECK (device ~ '^[0-9a-f]{64}$'),
    created timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project, id)
);
