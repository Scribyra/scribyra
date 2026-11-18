-- Server compile (org-sync slice 11, design section 6): one row per compile request of a
-- server-readable project. The rows are the queue (taken with FOR UPDATE SKIP LOCKED) and the
-- record CPU time is metered from; only the newest successful PDF and log and the newest failed
-- log keep their blobs (sealed with the project's data key, like every other object). Replaced
-- and finished rows stay without blobs. Append-only: never edit an applied file.
CREATE TABLE compiles (
    job text PRIMARY KEY CHECK (job ~ '^[0-9a-f]{64}$'),
    project text NOT NULL REFERENCES sr_projects (project) ON DELETE CASCADE,
    -- The log sequence number the files were materialised at, and their digest (cache key with
    -- `engine` and `texlive`, the TeX Live store path's name).
    seq bigint NOT NULL,
    content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    engine text NOT NULL CHECK (engine IN ('pdflatex', 'xelatex', 'lualatex')),
    texlive text NOT NULL,
    requested_by text REFERENCES accounts (account) ON DELETE SET NULL,
    -- `replaced`: a newer request for the project took its place while it was queued.
    state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'done', 'failed', 'replaced')),
    queued timestamptz NOT NULL DEFAULT now(),
    started timestamptz,
    finished timestamptz,
    -- Running jobs: the worker that holds it and its last sign of life. `attempts` counts the
    -- claims a lost worker used up; a job is requeued once, then failed.
    worker text,
    heartbeat timestamptz,
    attempts integer NOT NULL DEFAULT 0,
    -- Finished jobs: `success`, `tex_error`, `limit_<cpu|wall|memory|output|scratch|processes>`,
    -- `rejected`, `sandbox_failure`, `cancelled`, `lost` (no heartbeat) or `quota`; `error` is a
    -- fixed message of the service's own (never project content).
    outcome text,
    error text,
    cpu_ms bigint,
    passes integer,
    pdf_blob text,
    pdf_size bigint,
    pdf_bytes bigint,
    log_blob text,
    log_size bigint
);
CREATE UNIQUE INDEX compiles_one_queued ON compiles (project) WHERE state = 'queued';
CREATE UNIQUE INDEX compiles_one_running ON compiles (project) WHERE state = 'running';
CREATE INDEX compiles_queue ON compiles (queued) WHERE state = 'queued';
CREATE INDEX compiles_running ON compiles (heartbeat) WHERE state = 'running';
CREATE INDEX compiles_project ON compiles (project, queued DESC);
CREATE INDEX compiles_requester ON compiles (requested_by, queued);
