# Compiler log fixtures

Captured from the provisioned LuaLaTeX browser runtime on November 5, 2026,
using `nix develop -c node scripts/measure-agent-surface.mjs tmp/agent-before`
against the unmodified A1/A2 baseline production build.

- `article.txt`: `fixtures/article`, cold compilation, all passes. Three warnings
  occur in the first pass; subsequent passes resolve the references.
- `missing-package.txt`: `fixtures/missing-package`, failed compilation. The
  missing dependency is `scribyra-does-not-exist.sty`; the source is `main.tex:1`.
- `thesis-error.txt`: `fixtures/thesis` after a successful compile, with
  `\undefinedcmd` and a newline prepended to `chapters/page-050.tex`. The source
  error is on line 1 of that file.

These are full returned logs, including command boundaries and log/stdout
copies. They contain only the repository's synthetic documents. Rust tests
exercise attribution and warning deduplication directly against these bytes.
