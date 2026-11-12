# Compiler worker fixture

`busytex_worker.js` is the unmodified classic worker from the verified
TeXlyre-BusyTeX assets-v1.4.1 distribution used by Scribyra. It was retained before
the local observation patch, so fresh patch/idempotence tests need only this 3-KiB
source, rather than another 522-MB compiler archive download.

Archive SHA-256: `4f63731fe4ec9238d877846074ab424350add6f6e956944def389e6752d2c78b`.
Worker SHA-256: `80eca56a2eb015bdfbebff26e539dd793407b73b6c1cd351170e6fdb6e17c39a`.

Upstream release and source/build/license provenance are recorded in
[THIRD_PARTY.md](../../../THIRD_PARTY.md).
