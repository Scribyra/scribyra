-- Project key epochs (org-sync slice 7). Append-only: never edit an applied file.
--
-- `projects.epoch` follows the signed `project.epoch` events. `epoch_cutover` is the log head at
-- the moment the service appended the latest one: from then on it accepts only entries under the
-- new epoch (repeats of entries it already holds excepted). Clients do not trust this cutover;
-- they apply the `after` position the rotating client signed.
ALTER TABLE projects ADD COLUMN epoch_cutover bigint CHECK (epoch_cutover >= 0);
