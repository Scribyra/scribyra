# Large real projects: performance and backup size

Measured November 9–10, 2026 for the beta gate item "Large real projects: performance and backup size measured". Three generated projects went through the real UI in Chromium, Firefox and WebKit with Playwright, three runs each, and the tables give medians. This document records what was measured, the bottlenecks found and what was fixed, the limits to tell beta users, and what remains untested.

**Verdict (November 11, 2026): the history part is fixed; the gate item stays open on the save cost.** Projects that are large in content are usable: a 300-page thesis with 40 MB of figures, or a 3 MiB single file. Long editing histories were not, and history format 2 fixes their storage (see [Stored history size after the fix](#stored-history-size-after-the-fix)): stored history now grows linearly at about 3 bytes per typed character, a typed 1.4-million-character thesis stores 4.6 MB of history, and the 306 MB heavy-history project compacts to 53 MB and exports a complete backup again. Before the fix, a project could not even be typed past about 9,600 characters: every keystroke wrote a change record and the 10,000-record bound refused the next save. What remains is bottleneck 5: a save still encodes the whole document several times on the main thread, which costs about 0.2–0.7 s per save once the document is a few megabytes.

The November 9–10 text below is kept as measured then.

## The generated projects

`node scripts/large-projects.mjs [dir]` writes everything to `tmp/large-projects` by default. Content is deterministic and contains no copyrighted text: sentences are drawn from a fixed vocabulary by a seeded generator, and equations, tables, PNG "measurement maps", vector PDF charts and BibTeX entries are synthesized.

| Project | What it contains |
| --- | --- |
| **Thesis** (`thesis.zip`, 40.4 MB, 75 files) | `report` class with 12 chapter files in `chapters/NN-name/` folders and an appendix, 1.46 MB of source (1.36 MB TeX plus 400 BibTeX entries), and 60 figures: 54 PNGs and 6 PDFs, 40.2 MB in all. It has 36 booktabs/siunitx tables, equations, `\ref`/`\eqref` cross-references and `\cite`/`\nocite{*}`, using amsmath, amssymb, graphicx, booktabs, siunitx, biblatex with Biber, hyperref and geometry. It compiles to **305 pages**. siunitx and biblatex are not in the bundled core, so they are installed from the local component store on the first compile; no network is involved. |
| **Long file** (`long-file.zip`) | One 3 MiB `main.tex` with 16,276 lines and 902 sections of prose and equations. It was not compiled, since that would be about 1,000 pages. |
| **Heavy history** | A 6-chapter report: 423 KB of source and three small images. It was built with the app's own storage, comment, review and history modules (`scripts/large-projects-history.mjs`, with fake-indexeddb in Node). It records 5,000 edits, each saved as it would be after a typing pause, 140 comment threads with 35 replies, 60 suggestions in 6 reviews, and 20 named versions. Its complete backup could not be exported (see below), so the generator also dumps the stored IndexedDB records, and the spec installs them into each browser before measuring. |

At the end, the heavy-history project stores **306 MB**: a 5.05 MB snapshot, 105 automatic checkpoints (231 MB, one every 50 saves, each a full copy), a 22 MB journal of 5,220 entries and 48 MB of named-version objects. Growth is quadratic:

| Saves | 500 | 1,000 | 2,000 | 3,000 | 4,000 | 5,000 |
| --- | --- | --- | --- | --- | --- | --- |
| Snapshot | 0.4 MB | 0.8 MB | 1.6 MB | 2.6 MB | 3.7 MB | 5.1 MB |
| Stored history | 4.8 MB | 13 MB | 46 MB | 103 MB | 188 MB | 306 MB |

## How it was measured

- `tests/browser/large-projects.spec.js` (opt-in: `SCRIBYRA_LARGE_PROJECTS=<dir>`, plus `SCRIBYRA_LARGE_LIMITS=1` for the edge cases) drives the real UI. Each run uses a fresh browser profile and appends one JSON line per scenario. `scripts/large-projects-report.mjs` takes medians into [measurements/large-projects.json](measurements/large-projects.json) and leaves out runs that stopped early.
- **Typing latency** runs from the keydown event's timestamp to the first task after the next animation frame, that is, after paint. Forty keys are typed in word-sized bursts at 110 ms intervals, with a 450 ms pause every seven keys, so the app's debounced local save runs between bursts as it would for a person.
- **Open** runs from the dashboard click until the editor is editable, after a reload. **Import** runs from file selection until the editor appears. **Compile** times include rendering the first PDF page. A **saved keystroke** runs from one key until "Saved locally", which includes the app's 160 ms debounce.
- **Storage** is the change in `navigator.storage.estimate().usage`. Chromium's figure is close to the real IndexedDB size. Firefox's roughly doubles it. WebKit's estimate is coarse and includes its caches. The compiler runtime cache is excluded because the estimate is taken before the first compile.
- **Memory** is `performance.memory.usedJSHeapSize`, which only Chromium provides. Firefox and WebKit expose no comparable figure to a page.
- The host was a shared 10-core Xeon LXC with a load of 10–15 from other agents, running headless browsers with software rendering. WebKit ran under Mesa llvmpipe. Absolute times are pessimistic compared with a recent laptop; the ratios between scenarios are the useful part.

## Results (median of 3 runs)

| Measurement | Chromium | Firefox | WebKit |
| --- | --- | --- | --- |
| **Thesis: runs** | 3 | 3 | 3 |
| ZIP import (40.4 MB) | 3.7 s | 5.5 s | 3.6 s |
| Open from dashboard | 973 ms | 1.4 s | 1.1 s |
| Typing p50 / p95 (chapter, idle) | 71 / 90 ms | 65 / 98 ms | 62 / 91 ms |
| Typing p50 / p95 while compiling | 112 / 156 ms | 59 / 92 ms | 63 / 123 ms |
| One saved keystroke (incl. 160 ms debounce) | 389 ms | 645 ms | 365 ms |
| Project search, 868 hits / 1 hit | 549 ms / 194 ms | 528 ms / 204 ms | 738 ms / 311 ms |
| First compile (fresh profile, 305 pages) | 236.2 s | 249.4 s | 248.2 s |
| Recompile after an edit | 173.2 s | 182.7 s | 225.2 s |
| Longest frame during compile | 250 ms | 167 ms | 264 ms |
| PDF: jump to middle, page drawn | 405 ms | 314 ms | 483 ms |
| PDF: 3 s fast scroll, p95 / longest frame | 117 ms / 150 ms | 66 ms / 68 ms | 90 ms / 105 ms |
| Storage added by import (estimate) | 39.1 MiB | 78.1 MiB | 41.2 MiB |
| JS heap after open / after compile | 146.2 MiB / 230.8 MiB | n/a | n/a |
| **Thesis history: runs** | 3 | 3 | 3 |
| History view open | 2.0 s | 2.0 s | 1.7 s |
| Complete backup: export time / size | 12.8 s / 39.0 MiB | 11.5 s / 39.0 MiB | 10.5 s / 39.0 MiB |
| Backup restore (plan + import) | 16.4 s | 16.1 s | 13.5 s |
| Storage added by the restored copy | 1.3 MiB | 40.5 MiB | 44.1 MiB |
| Source ZIP export: time / size | 2.8 s / 38.6 MiB | 3.3 s / 38.6 MiB | 2.9 s / 38.6 MiB |
| **Long file: runs** | 3 | 3 | 3 |
| ZIP import | 651 ms | 640 ms | 740 ms |
| Open from dashboard | 128 ms | 118 ms | 197 ms |
| Typing p50 / p95 at start | 21 / 29 ms | 20 / 39 ms | 32 / 109 ms |
| Typing p50 / p95 in the middle | 24 / 50 ms | 19 / 27 ms | 32 / 119 ms |
| Typing p50 / p95 at the end | 26 / 50 ms | 18 / 27 ms | 31 / 128 ms |
| One saved keystroke / longest frame | 406 ms / 100 ms | 430 ms / 84 ms | 373 ms / 81 ms |
| Search, preview limit / 1 hit | 1.4 s / 321 ms | 1.3 s / 253 ms | 1.7 s / 316 ms |
| Storage added by import | 1.1 MiB | 1.5 MiB | 6.0 MiB |
| **Heavy history: runs** | 3 | 3 | 3 |
| Storage after seeding | 130.0 MiB | 158.3 MiB | 293.4 MiB |
| Open from dashboard | 878 ms | 962 ms | 1.1 s |
| Typing p50 / p95 (chapter with comments) | 213 / 832 ms | 673 / 1390 ms | 314 / 1181 ms |
| One saved keystroke / longest frame | 1.4 s / 550 ms | 1.9 s / 801 ms | 1.6 s / 582 ms |
| History view open (127 versions) | 42.5 s | 56.4 s | 47.0 s |
| Complete backup | refused after 36.4 s | refused after 42.9 s | refused after 40.4 s |
| Clean up history (plan / apply) | 10.0 s / 30.4 s | 14.2 s / 45.2 s | 11.5 s / 33.4 s |
| Backup after clean-up: time / size | 35.0 s / 30.8 MiB | 46.2 s / 30.8 MiB | 38.1 s / 30.8 MiB |
| Restore of that backup | 52.4 s | 66.2 s | 53.4 s |
| Source ZIP export | 231 ms / 0.2 MiB | 310 ms / 0.2 MiB | 381 ms / 0.2 MiB |

Notes:

- All three Chromium thesis and long-file runs, two of the three Firefox thesis runs and one Firefox long-file run predate commit `ab414b4`, which removed one full encode from each save. The thesis has no comments, so the other typing fixes do not apply to it.
- "Longest frame" is the largest gap between animation frames. Compilation runs in a worker, so typing stays responsive while it runs, but PDF rendering and the save after a compile cause the visible stalls.
- Restoring the thesis backup as a second project adds 1.3 MiB in Chromium's estimate, because images are content-addressed and stored once. Firefox's and WebKit's estimates grow by 40–44 MiB. Their estimates track storage files rather than live records, so this is probably not a second copy of the images, but it was not verified on disk.
- WebKit's storage estimate for the heavy history (293 MiB, against 130 MiB in Chromium) is likewise an upper bound.

## Bottlenecks and what was fixed

1. **A 250-page thesis could not compile at all (fixed).** Each LuaLaTeX pass of the 305-page thesis takes 45–55 s in Chromium and Firefox and 50–85 s in WebKit. With Biber and cross-references, a compile needs four or five passes. Two 180-second limits stopped it in every engine. One was Scribyra's own cumulative compile budget. The other was a fixed timer in the pinned `texlyre-busytex` wrapper, which rejected every compile call after 180 s whatever the budget.
   **Fix:** the budget is now `COMPILE_BUDGET_MS = 600_000` (`web/compiler.js`). `liftWrapperDeadline` lifts only the wrapper's 180 s timer, which is set synchronously when the call starts, and warns if a future wrapper no longer sets it. A runaway TeX loop still ends at 600 s and can be cancelled at any time. The deadline test in `compatibility.spec.js` now also asserts that a compile is still running after 180 s. Figures are not the main cost: with `graphicx` in draft mode a pass still takes about 38 s.
2. **Typing in a project with a long history and many comments took 2.5 s per key (improved roughly tenfold).** Every keystroke records one change entry (about 414 bytes of snapshot per typed character; see below), and every keystroke did all of the following:
   - It projected comments three times (comment panel, editor marks, review panel), each time re-serializing every change record into the Rust projection.
   - It resolved every comment anchor by walking the whole text's item list.
   - It projected every suggestion's events four times, each time re-serializing all discussion events.
   - It copied each file's full text for each suggestion.

   **Fix:** the comment projection is cached until a discussion root, or a change record that a discussion event cites, changes; it reads only those cited records. Anchor resolution, capture and text strings are memoized per source text (`web/text-memo.js`), and review projections until `discussionEvents` changes. Memos are dropped before observers run for any transaction that touches their inputs, and are bypassed inside a transaction. Tests cover a root first seen as an untyped placeholder, which the first version got wrong and the random acceptance suite caught. Chromium went from p50/p95 2,460/3,088 ms to about 213/832 ms. The remaining time is mostly the save (next item) and panel state re-rendered on each key.
3. **History took 250 s to open on a 5,000-save project (improved to 40–60 s).** Opening History read three inventories (two list pages and the diff). Each one decoded and validated every automatic checkpoint three times.
   **Fix:** freshly derived checkpoints are verified from the document they came from, without a third decode or a second validation. The last inventory is reused for a minute while the stored history is unchanged, keyed on the project head and checkpoint identities. The time that remains grows with the number of automatic checkpoints.
4. **A complete backup of a long history failed after an hour and a half (now refused early, with a way out).** Automatic checkpoints travel twice in a backup: as journal updates and as derived checkpoint objects. The 5,000-save project's manifest therefore needed 549 MB, over the 512 MiB bound. In Node, export ran its whole validation for 82 minutes and then failed with "Invalid backup path, duplicate or size.". Validation also replayed every journal entry from its checkpoint, so its cost grew with entries times checkpoint size.
   **Fixes:** the manifest size is counted before validation (`backupBytes`). An oversized history is refused at once with "This project's history is too large for one complete backup (533 MiB of 512 MiB). Clean up history to remove automatic versions, then export again." Validation replays each checkpoint segment once (`replayEach`). After **Clean up history**, the same project exports a 31 MiB backup that restores in 50–70 s.
5. **Saving blocks the page for one to two seconds once the snapshot is several megabytes (not fixed).** Each save encodes and decodes the whole Yjs document about six times on the main thread: freezing a copy, merging with the stored head, comparing, validating every collaboration record in Rust, recording and applying the result back. Only one redundant encode was removed. Moving the save to a worker, or saving incremental updates, would change how the storage layer works and is a separate piece of work.

Not bottlenecks: opening (about 1 s for the thesis), project search (0.2–0.6 s for the thesis, 1.3 s for 3 MiB when 10,000 matches hit the preview limit), ZIP import and export (3–6 s for 40 MB), and PDF scrolling (frames stay within about 150 ms while pages render). The 3 MiB single file types at 20–30 ms p50 and about 50 ms p95.

## What needed a decision (approved November 11, 2026)

History grew by about 414 bytes per typed character, and stored history grew quadratically: every keystroke added a full change record to the project document, every 50 saves stored another full copy, and every journal row repeated the whole delete set. The owner approved both fixes on November 11, 2026: coalesce change records into typing bursts, and thin automatic versions on a ladder with delta storage, compacting existing projects safely. The design is in [history.md, "Stored history size"](history.md#stored-history-size-history-format-2-november-11-2026).

## Stored history size after the fix

Measured November 11, 2026 on the same shared host (load 9–18 from other agents and from these runs, which overlapped). The design is in [history.md](history.md#stored-history-size-history-format-2-november-11-2026); the raw lines and medians are in [measurements/history-size.json](measurements/history-size.json).

### Typing a document character by character

`scripts/typing-history.mjs` (Node, the app's own storage and history modules over fake-indexeddb) and `tests/browser/typing-history.spec.js` (the real app, opt-in with `SCRIBYRA_TYPING_HISTORY=<dir>`) type generated prose one character per transaction at a modelled human pace: 45–900 ms between keys, longer after spaces and full stops, 5–60 s between paragraphs, 3–25 minute breaks every few thousand characters, nights after 9,000–15,000 characters a day, a corrected typo (wrong key, Backspace) in 2.5% of letters, occasional insertions earlier in the text, bibliography entries and undo/redo. Time is virtual (Node: a patched `Date.now`; browsers: Playwright's clock), so the app's 160 ms save debounce, typing bursts and automatic versions see human pacing. A save follows every key that is followed by a pause longer than the debounce, as in the editor: about 6 saves per 10 typed characters.

**Before (main, Node):** stored history grows quadratically and the project stops saving at **9,589 characters** (10,000 keystrokes): "Collaboration record limit exceeded." By then it stores 251 MB, a save takes 0.7 s and History cannot even be listed. At 3,000 characters a complete backup took 109 s for 8 MB.

| Typed characters | 1,000 | 3,000 | 5,000 | 9,000 | 9,589 |
| --- | --- | --- | --- | --- | --- |
| Change records | 1,034 | 3,120 | 5,186 | 9,368 | 10,000 (save refused) |
| Project document | 0.42 MB | 1.25 MB | 2.07 MB | 3.74 MB | 4.0 MB |
| Stored history | 3.1 MB | 25 MB | 68 MB | 219 MB | 251 MB |
| Save (Node median) | 38 ms | 182 ms | 336 ms | 735 ms | |

**After (this change, Node, saving after every key as above):** linear, about **2.8 bytes of stored history per typed character**.

| Typed characters | 10,000 | 30,000 | 50,000 | 70,000 | 100,000 |
| --- | --- | --- | --- | --- | --- |
| Virtual time | 1.3 h | 1.4 days | 2.8 days | 4.1 days | 7.1 days |
| Change records (bursts) | 25 | 79 | 132 | 185 | 263 |
| Project document | 29 KB | 81 KB | 133 KB | 186 KB | 266 KB |
| Stored history | 35 KB | 95 KB | 140 KB | 191 KB | 280 KB |
| Save (Node median / p95) | 3 / 6 ms | 11 / 15 ms | 19 / 25 ms | 28 / 34 ms | 38 / 47 ms |

At 100,000 characters (63,179 saves): History lists 20 versions in 97 ms, a complete backup takes 0.9 s and is 176 KB, and restoring the oldest automatic version as a copy takes 244 ms.

**A typed thesis, 1.4 million characters (Node).** Every key is still its own transaction, but saving after every key would take days of machine time, so this run saves only after pauses longer than 3 s (5,480 saves; maintenance merges the steps between versions either way). Over 133 virtual days it stores **4.6 MB of history** (3.5 MB of journal and two full copies of 0.8 and 0.3 MB) for a **3.5 MB** project with **3,304 change records**, far below the 64 MiB project bound and the 10,000-record bound. Growth stays linear (3.2–3.3 bytes per character from 100,000 to 1.4 million characters). At the end, History lists 42 versions in 2.1 s, a complete backup takes 8 s and is 2.0 MB, and restoring the oldest automatic version as a copy takes 4 s. Each save takes about 0.7 s in Node for a 3.5 MB document (bottleneck 5, below), and maintenance about 1–2 s per run on the main thread, once per 600 saves or hour.

In the browsers (the real app, Playwright clock), the same typist ran in Chromium to 100,000 characters (62,883 saves, 4.7 hours of machine time) and in Firefox and WebKit to 50,000 characters, where the runs were stopped because the clock-driven harness slows down with document size (each save step also runs the page's virtual animation frames, so the harness's time per save is not the app's save time). One run per engine; the typing probe is 40 real keys at each milestone, timed from keydown to the first task after paint:

| | Chromium | Firefox | WebKit |
| --- | --- | --- | --- |
| Stored history at 10,000 / 50,000 characters | 45 / 155 KB | 44 / 157 KB | 45 / 155 KB |
| Stored history at 100,000 characters | 283 KB (2.8 B/char) | — | — |
| Project document at 50,000 characters | 136 KB | 152 KB | 151 KB |
| Typing p50 / p95 at 10,000 characters | 17 / 31 ms | 13 / 21 ms | 17 / 23 ms |
| Typing p50 / p95 at 50,000 characters | 15 / 18 ms | 14 / 28 ms | 18 / 27 ms |
| Typing p50 / p95 at 90,000 characters | 16 / 23 ms | — | — |
| History open / complete backup / restore of the oldest automatic version as a copy | 0.77 s / 1.1 s, 157 KB / 1.1 s (at 100,000 characters) | 0.31 s / 0.27 s, 24 KB / 0.59 s (separate 10,000-character run) | 0.29 s / 0.19 s, 24 KB / 0.64 s (separate 10,000-character run) |

Before the change the same typing could not get past about 9,600 characters in any engine (the record bound is enforced in the shared Rust validator), and the November 9–10 thesis run measured 414 bytes of snapshot per typed character in Chromium.

### The 306 MB heavy-history project

The same generator as above, run with the code from before the change, produced the same project (5,000 saves, 140 threads, 60 suggestions, 20 named versions; 301 MB of stored history: 105 full checkpoints, 5,220 journal rows, 48 MB of named versions). The spec installs those records into each browser. With this change, opening it once compacts it: a recovery copy is saved, 810 of 5,261 change records are merged (the generator wrote one record per burst already), and maintenance a few seconds later merges the journal and thins the automatic versions. Median of 3 runs:

| Heavy history | Chromium before → after | Firefox before → after | WebKit before → after |
| --- | --- | --- | --- |
| Open from dashboard (after: includes the record merge and recovery copy) | 878 ms → 4.5 s | 962 ms → 6.4 s | 1.1 s → 4.3 s |
| Compaction finished (from the click) | — → 26 s | — → 37 s | — → 26 s |
| Stored history | 301 MB → 52.7 MB | 301 MB → 52.7 MB | 301 MB → 52.7 MB |
| Typing p50 / p95 (chapter with comments) | 213 / 832 ms → 164 / 821 ms | 673 / 1390 ms → 212 / 1400 ms | 314 / 1181 ms → 308 / 1419 ms |
| One saved keystroke | 1.4 s → 1.4 s | 1.9 s → 2.0 s | 1.6 s → 1.7 s |
| History view open | 42.5 s → 10.2 s | 56.4 s → 12.5 s | 47.0 s → 10.8 s |
| Versions listed | 127 → 24 | 127 → 24 | 127 → 24 |
| Complete backup | refused after 36.4 s → 41 s, 17.8 MB | refused after 42.9 s → 50 s, 17.8 MB | refused after 40.4 s → 42 s, 17.8 MB |
| Clean up history (plan / apply) | 10.0 / 30.4 s → 9.3 / 24.6 s | 14.2 / 45.2 s → 12.5 / 31.8 s | 11.5 / 33.4 s → 10.2 / 26.1 s |
| Restore of a complete backup | 52.4 s (after clean-up) → 55.8 s | 66.2 s → 65.8 s | 53.4 s → 56.9 s |

The 52.7 MB that remain are the 20 named versions (47.7 MB; each is a full copy, kept forever), 4.9 MB of merged journal and one 0.13 MB full copy. The runs happened within hours of generating the project, so the ladder still kept the versions from the last hour and hour buckets (2–6 automatic versions); run as if opened a week later (`LATER_DAYS=7 node scripts/compact-dump.mjs`), one automatic version and the 20 named ones remain, at the same size. In Node the compaction takes 15 s to open and 37 s of maintenance (21 s a week later), and the backup validates on import in 40 s.

Typing and saving in this project are no faster: what remains there is the save cost (bottleneck 5) and comment panels, not stored history. **Clean up history** is rarely needed now. In format 2 it never writes a copy: it first merges the steps between versions (every listed state unchanged), then in one guarded commit removes the versions not kept (their journal flag or catalogue entry and objects), pins the chosen ones against automatic thinning and releases assets no remaining state refers to, and then merges across the removed versions. A merged row keeps the smaller of two encodings, or the rows stay separate, so stored history can only shrink. On this project (opened the same day, 100 versions) clean-up keeping one automatic version leaves 22 versions and 52,880,059 of 52,881,607 stored bytes; the kept version and the 20 named ones restore as copies (`scripts/compact-dump.mjs` checks this and fails if bytes grow). The figures in the table above were measured before this change to clean-up, which then replaced the journal by full copies (backup 17.8 → 32.5 MB).

### Users see in History

- Automatic versions: at most one per 5 minutes of saving plus one before each pause of 2 minutes or more, instead of one per 50 saves; older ones thinned to one per hour, day and week. Named, before-restore and starting-point versions are unchanged.
- Contributors per version are unchanged. A diff from a version also names people whose typing burst began in the 5 minutes before it (their later keys carry the burst's record).
- Projects from before the change briefly show a second project, "… (before history compaction)", on the dashboard while they are compacted; it disappears when the compacted history is verified, unless it was opened and edited. If verification fails, maintenance stops, the copy stays and the person is told.


## Edge cases at the limits

Run once per engine (`SCRIBYRA_LARGE_LIMITS=1`). Chromium, Firefox and WebKit gave identical results:

| Case | What happens | Data |
| --- | --- | --- |
| ZIP file larger than 64 MiB | "ZIP exceeds 64 MiB." | No project is created. |
| ZIP under 64 MiB that expands past it (70 MiB of text) | "Expanded ZIP exceeds 64 MiB." | No project is created. |
| ZIP with 600 files | "Projects support up to 512 files and 1024 total tree entries." | No project is created. |
| Upload that would take a 63.8 MiB project past the bound | "Project and recoverable deleted files exceed 64 MiB. Export a backup or use a new project." | The upload is refused and the tree is unchanged. |
| Typing or pasting text that takes a project past the bound | The save indicator shows "Not saved · export a backup", with "Local save failed (Error): Project and recoverable deleted files exceed 64 MiB.. Export your project before closing this tab." | The editor keeps the unsaved text. After undo the project saves again. A reload restores the last saved state. Nothing saved is lost, but text typed past the bound exists only in the tab until it is exported or removed. |

The bound is enforced honestly and nothing already saved is lost. Two rough edges remain. The second-to-last message has a doubled full stop, and project search reports "1 matches" (tests assert that text, so it was left alone). More seriously, there is no way to purge deleted files, so a project whose trash holds large figures cannot get back under the bound.

## Recommended limits for beta users

- **Project size:** up to about **40 MB of figures and 1.5 MB of source**, around 300 pages, works in all three engines. The hard bound is 64 MiB, and it includes deleted files, which stay recoverable. There is no way to purge them, so replacing large figures by deleting and re-adding them uses up the bound. Use **Replace file** instead, or export a source ZIP and import it as a new project.
- **Single file:** a 3 MiB file edits smoothly. Splitting chapters into files keeps search, diff and history cheaper.
- **Compile time:** expect about **4 minutes** for the first compile and **3–4 minutes** for each recompile of a 300-page thesis with Biber, in all three engines on this server-class CPU. Every compile starts from scratch. Use `\includeonly` while writing, and compile the whole document when needed. Compiles stop after 10 minutes.
- **History:** no manual clean-up is needed any more (Clean up history never increases storage). Stored history grows by about 3 bytes per typed character; automatic versions are thinned to every version from the last hour, then one per hour, day and week; named versions are kept forever and each costs a full copy of the project (so name versions for milestones, not every hour). Projects from before November 11, 2026 are compacted the first time they are opened, with a recovery copy kept until the result is verified.
- **Backups:** a complete backup is about the size of the project plus its retained history: 39 MiB for the thesis, 31 MiB for the cleaned-up heavy history. Restoring one takes 15–70 s.

## Untested

- Real Mac hardware and Safari (WebKit here is Playwright's Linux build with software GL), Windows, and low-end or mobile hardware. Low-memory devices are the biggest unknown: Chromium's JS heap reached about 230 MiB after compiling the thesis and 290 MiB on the heavy history.
- GPU-accelerated PDF rendering. All three engines used software rendering.
- Real typing by people over weeks. The typing simulation types every character as its own transaction at a modelled human pace with virtual time; real pauses, editing patterns and multi-tab use will differ.
- Compiling the 3 MiB single file, and projects near 512 files.
