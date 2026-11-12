# Scribyra page recipe (app without `window.scribyra.v1`)

Works on the current tab only, and needs page JavaScript. It reads internal app hooks with no compatibility promise, so errors named `hook-missing:*` mean this recipe is stale.

Inject once per page load by running `scripts/sc.js` as your tool's evaluate function. It returns `sc1`. After any reload or navigation, inject it again. A reload closes the project: `no-project-open` means click its card on the dashboard, which is not a stale recipe.

| Call | Returns |
| --- | --- |
| `__sc.st()` | project, active file, file count, busy |
| `__sc.compile()` | outcome line; waits for the build; `busy` if one is running |
| `__sc.sum()` | last outcome: `ok errors warnings overfull at=file:line status` |
| `__sc.diag()` | up to 10 issues and 10 warnings |
| `await __sc.open('chapters/a.tex')` | switches the active file |
| `__sc.read(line, context=5)` | numbered lines, including ones not rendered |
| `__sc.edit(find, replace)` | `edited line=N`, `not-found`, `ambiguous` or `composing` |

- `at=` is parsed from the log and is a best guess. `errors` comes from the app and may lack a file.
- `edit` needs text that occurs exactly once in the active file. Re-read rather than guess if it fails.
- If a tool call would time out on a long compile, call `__sc.compile()` anyway and poll `__sc.st()` until `busy=0`, then `__sc.sum()`.
