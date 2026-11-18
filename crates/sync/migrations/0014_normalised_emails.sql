-- Review L2: emails are stored normalised (trimmed, lowercase) and compared with `=`, never with
-- lower() (which follows the database's locale). Rows from before get their ASCII letters
-- lowercased here; a sign-in stores the full normal form. Append-only: never edit an applied file.
UPDATE accounts SET email = btrim(translate(email, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')) WHERE email IS NOT NULL;
CREATE INDEX accounts_email_normalised ON accounts (email) WHERE email_verified;
