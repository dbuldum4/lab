# lab

A local-only, local-first Markdown notepad. There is no toolbar: type `/` in an empty line to open every command.

## Keyboard shortcuts

The slash palette remains the complete command surface. Frequently used actions
also have shortcuts: `Cmd/Ctrl+K` opens sessions, `Cmd/Ctrl+Shift+F` searches
all notes, `Cmd/Ctrl+Shift+S` shows statistics, `Cmd/Ctrl+Alt+H` opens version
history, `Cmd/Ctrl+Shift+K` edits the link around the caret,
`Cmd/Ctrl+Shift+N` creates a session, `Cmd/Ctrl+S` exports the current note,
and `Cmd/Ctrl+/` shows the full shortcut reference. Standard editor shortcuts
for undo, redo, bold, italic, and selection continue to work.

## Outline

Use `/outline` (or `Cmd/Ctrl+Shift+O`) to toggle a side outline built from the
note's `#`, `##`, and `###` headings. It updates as you edit, keeps heading
levels indented, marks the section around the caret, and jumps to a heading
when selected. The outline is keyboard accessible: use `Tab` to reach it,
`Enter` or `Space` to navigate, and `Escape` to close it. On narrow screens it
opens as a local overlay and closes after navigation. Its open/closed state is
UI-only and is not saved with the document.

## Themes

Use `/theme` to open the theme submenu. Dark is the default theme. The browser
stores your selection on this device. The submenu also includes Light,
Dracula, Nord, Solarized Dark, and Catppuccin Mocha. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the third-party licenses.

## Run locally

Requires Node.js 22.6 or newer.

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Deploy

Pushes to `main` deploy a static export to GitHub Pages at
`https://denizbuldum.org/lab/`.

## Testing

For performance work, start with the [performance test guide](PERFORMANCE.md).
This command runs every weighted metric and reports one aggregate index:

```bash
npm run perf:score
```

Fast unit, storage-contract, and editor-persistence tests run with Node's built-in test runner:

```bash
npm run test:fast
```

Repeatable performance tests cover full-vault search and indexing, large outline
updates, 2,000-session backup work, and real Chromium load, paste, typing,
scrolling, outline, history, persistence, and difficult-document paths. The
browser tests use the production static export, one worker, fixed browser
settings, deterministic corpuses, explicit warmups, and stable painted DOM
completion checks. The output includes raw JSON samples plus the median, p95,
and median absolute deviation (MAD):

```bash
npm run test:perf
```

Run only the library or browser layer when investigating a result:

```bash
npm run test:perf:unit
npm run test:perf:e2e
npm run test:perf:extended
```

The default is 11 unit samples and 7 browser samples. Increase the counts for a
long confirmation run:

```bash
LAB_PERF_UNIT_SAMPLES=25 LAB_PERF_SAMPLES=15 npm run test:perf
```

Performance timings are sensitive to system load. For a diagnostic run that
reports all timings but does not enforce the broad median regression budgets,
use:

```bash
LAB_PERF_REPORT_ONLY=1 npm run test:perf
```

For performance work, record an unchanged run first. Make one change, then run
the same command again under similar machine load. Compare medians and use MAD
as the noise signal. Treat a change smaller than the run-to-run noise as
inconclusive. The fixed budgets catch large regressions; they are not a claim
that a small timing change is significant.

The fast suite includes a compact seeded reference-model test. Re-run one failing model seed with bounded steps using:

```bash
LAB_MODEL_SEED=0x5eedc0de LAB_MODEL_STEPS=64 npm run test:model
```

The Chromium suite uses real localStorage, IndexedDB, and OPFS. Install the browser once, then run:

```bash
npx playwright install chromium
npm run test:e2e
```

`test:e2e` excludes the opt-in performance and repeated concurrency stress cases. Run the browser performance layer with `npm run test:perf:e2e`, or run the stress case with a reproducible seed and bounded iteration count:

```bash
LAB_STRESS_SEED=0x20260802 LAB_STRESS_ITERATIONS=8 npm run test:stress
```

Stress failures print the seed, iteration, and schedule; replay the same seed with `LAB_STRESS_ITERATIONS` set through the failing iteration. The quota contract tests use standards-shaped `QuotaExceededError` failures for each backend. Chromium CDP quota override is covered once for the reliable IndexedDB/OPFS path; localStorage is intentionally kept at the contract layer because Chromium 140 does not apply that override to it.

`npm run verify` runs the fast and performance suites, Chromium E2E, lint, typecheck, and production build.

## Privacy

`lab` has no accounts, analytics, API routes, or remote assets. GitHub Pages cannot set custom response headers, so the static export supplies a meta-delivered Content Security Policy that limits connections and application assets to the same origin. Notes stay local to the browser and are written redundantly to localStorage, IndexedDB, and the browser's origin-private file system when available. Integrity checks detect accidental or corrupted snapshots; they are not encryption, so this app does not promise encrypted at-rest storage.

Use `/export` for a portable Markdown copy and `/import` to restore one.

Use `/backup` to download `lab-vault-backup.json`, a versioned JSON snapshot of
the whole local vault. It contains every live session's id, name, timestamps,
and Markdown. Embedded `data:image/...` images are moved into a deduplicated
asset table so the backup remains a single portable file. The backup is local
data only; it does not fetch remote images.

Use `/restore` to choose a backup file. The file is parsed and validated in
full before anything is written: unsupported versions, duplicate ids, invalid
timestamps, malformed image data, missing image assets, and truncated JSON are
rejected without changing the vault. Restore is a non-destructive merge—an
exact existing session is skipped, and a conflicting or tombstoned session is
imported under a new id. Existing sessions are never replaced and deleted
session ids are never revived. If storage fails during a multi-session import,
completed imports remain intact and the failed session is reported so the user
can retry safely.

## Sessions

The original note remains the default, so existing users do not need to manage documents. Use `/new` to start a separate local document, `/name` to give the current document a recognizable name, `/sessions` to resume another document, and `/delete` to permanently remove an extra session (the original cannot be deleted; use `/clear` to empty it). Until `/name` is used, the session title follows the note's first heading or readable line. A manual name is never overwritten.

Use `/pin` and `/unpin` to control which sessions stay at the top of active
lists. `/archive` hides a non-original session without deleting its note or
history; `/archives` browses archived sessions and `/unarchive` returns one to
the active list. Pin, archive, and automatic/manual-title metadata are included
in whole-vault backups.

Each session has its own URL hash and isolated redundant storage. Different sessions can stay open and save independently in different tabs. Two tabs opened to the same session still use atomic conflict resolution, with the losing edit retained for `/recover` rather than silently discarded.

Use `/search` (or type `/find`) to search session names and the text of every local session. Results include a short excerpt and open the matching session with Enter or a click. Search reads verified on-device snapshots only; it makes no network requests and does not create a new remote index.

Use `/link-note` to insert a normal Markdown link to another local session and
`/backlinks` to find every local note that points to the current one. Local-link
navigation uses the same session safety and save boundary as `/sessions`.

## Statistics and history

`/stats` reports readable words, characters, paragraphs, headings, code blocks,
and estimated reading time at 225 words per minute. Markdown punctuation does
not inflate the counts.

Successful durable saves create deduplicated, per-session local history.
`/history` lists and restores those versions while preserving the current text
as another version first. History is bounded to 50 entries and 1 MiB per
session and is deleted when its session is permanently deleted.

## Structured blocks

Use `/callout-note`, `/callout-tip`, `/callout-warning`, or
`/callout-important` for editable callouts. They export as GitHub-style
`> [!NOTE]` alert blockquotes. `/details` inserts an editable collapsible
section that round-trips through safe `<details>` and `<summary>` Markdown.

Table commands add or remove the row or column around the caret, toggle a
header row, or remove the table. `/language` creates or updates a fenced code
block language; `Cmd/Ctrl+Alt+L` opens the same chooser from inside code.

Place the caret inside a link and use `/edit-link` or `Cmd/Ctrl+Shift+K` to
change its text and destination or remove the link. Selecting an image exposes
`Details` alongside crop, center, resize, and delete controls; it edits portable
alt text and the optional Markdown image title.

## Math

Type `$$...$$` to turn an inline expression into KaTeX-rendered math. Use
`/math` (or `/latex`) for a centered block equation. Equations remain local,
editable, and round-trip through Markdown import/export.
