-- Server compile requests (org-sync slice 11, review M2): one row per request that got past the
-- rate limits, whatever it answered (queued, cached, existing or an error), recorded before the
-- project is materialised. The per-member hourly and per-project per-minute limits count these
-- rows; rows older than an hour are removed. Append-only: never edit an applied file.
CREATE TABLE compile_requests (
    account text NOT NULL REFERENCES accounts (account) ON DELETE CASCADE,
    project text NOT NULL REFERENCES sr_projects (project) ON DELETE CASCADE,
    at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX compile_requests_account ON compile_requests (account, at);
CREATE INDEX compile_requests_project ON compile_requests (project, at);
CREATE INDEX compile_requests_at ON compile_requests (at);
