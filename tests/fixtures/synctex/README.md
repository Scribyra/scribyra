# SyncTeX engine fixtures

These are uncompressed SyncTeX outputs generated from Scribyra's own `article` and `unicode` documents in `scripts/fixtures.py`, using the pinned TeXlyre-BusyTeX 1.4.1 / TeX Live 2026 compiler. The compiler matrix exercises those same documents. No user paper or user content is included. Input records intentionally retain compiler-internal package and generated auxiliary paths so tests exercise manifest filtering.

The reference C parser is jlaurens/synctex commit `04cf8e3e8665ff203248d7af78ee1129afbc1b64`; see the vendor provenance for build details. Copy a fixture to `main.synctex` beside a dummy `main.pdf` and query:

```sh
synctex view -i 6:0:/home/web_user/project_dir/main.tex -o main.pdf
```

First rectangle values from the canonical CLI (PDF points, y measured from top):

| Fixture | Page | Left | Top | Bottom | Width |
| --- | --- | --- | --- | --- | --- |
| article-pdflatex | 1 | 133.768356 | 283.842239 | 298.046844 | 343.711060 |
| unicode-xelatex | 1 | 133.768372 | 149.572096 | 158.588272 | 343.711060 |
| unicode-lualatex | 1 | 133.768356 | 0 | 158.588272 | 343.711060 |

The LuaLaTeX output contains glyph records with zero vertical positions, producing a tall rectangle in both implementations. The reader limits the visual decoration to its bottom 24 points; it does not change query geometry or claim word-level accuracy. The inverse query at x=200, y=bottom−4, page height=792 returns source line 6 for all three engines.
