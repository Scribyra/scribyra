-- An administrator's stop (disable or remove) in one organisation ends each of the account's
-- sessions there, and only there, for good: a session that also serves other organisations keeps
-- them, and one an administrator re-enabled later does not get the organisation back (a new
-- sign-in does). Before, the stop revoked every session at the organisation's provider, ending the
-- person's work in their other organisations too. Append-only: never edit an applied file.
CREATE TABLE sso_login_stops (
    token_hash text NOT NULL REFERENCES sso_logins (token_hash) ON DELETE CASCADE,
    org text NOT NULL REFERENCES organisations (org) ON DELETE CASCADE,
    PRIMARY KEY (token_hash, org)
);
