-- Review L1: a client's sequence numbers belong to the account that uses them, so another member
-- reusing someone's client ID cannot take their slots. Append-only: never edit an applied file.
CREATE UNIQUE INDEX sr_entries_client ON sr_entries (project, account, client, client_seq);
ALTER TABLE sr_entries DROP CONSTRAINT sr_entries_project_client_client_seq_key;
