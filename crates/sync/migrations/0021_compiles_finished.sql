-- Server compile retention (org-sync slice 11, review L3): finished rows older than
-- `compile_limits.retention_days` are deleted unless they hold the newest PDF or log or are their
-- project's latest job; this index finds them. Append-only: never edit an applied file.
CREATE INDEX compiles_finished ON compiles (finished) WHERE state IN ('done', 'failed', 'replaced');
