# Foundation migration fixtures

These retained Yjs-v1 byte arrays model schemas 1–5. Schemas 1–2 use path metadata;
3 uses graph metadata, trash and inline assets; 4 uses hashed assets; 5 adds a TeX
environment lock. All include Unicode accepted text and a retained deleted text
root. Every fixture has a separate, older first recovery copy. `asset.bytes`
contains the original binary object; `update` and `firstBackup` are exact bytes,
not source-only reconstruction recipes. Client IDs and timestamps are fixed.

The unit and browser tests install the fixtures in old stores, assert exact
recovery and earlier-checkpoint bytes, preserve lock/source/asset/trash identities,
inject quota failures, reject old writers and retry migration. Browser tests also
hold a real older database connection open across a blocked upgrade. The fixtures
are synthetic; they do not establish performance on large real projects or actual
hardware storage exhaustion.
