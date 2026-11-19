-- An invitation shares with members and administrators of the project's organisation only,
-- unless the inviter explicitly invites a guest (`guest`): a pending invitation is then accepted
-- by a guest's sign-in too. Before, guests holding the email were shared with whatever the
-- inviter meant. Append-only: never edit an applied file.
ALTER TABLE sr_invitations ADD COLUMN guest boolean NOT NULL DEFAULT false;
