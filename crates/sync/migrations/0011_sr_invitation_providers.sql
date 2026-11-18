-- Review H2: an invitation names the provider whose account may take it (`provider:email`, or
-- the only provider), or none (any provider whose `email_domains` vouch for the email's domain).
-- Additive: replicas of the previous build keep working while this one rolls out. Append-only:
-- never edit an applied file.
ALTER TABLE sr_invitations ADD COLUMN provider text;
