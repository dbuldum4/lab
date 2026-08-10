# lab

A local-only, local-first Markdown notepad. There is no toolbar: type `/` in an empty line to open every command.

## Outline

Use `/outline` (or `Cmd/Ctrl+Shift+O`) to toggle a side outline built from the
note's `#`, `##`, and `###` headings. It updates as you edit, keeps heading
levels indented, marks the section around the caret, and jumps to a heading
when selected. The outline is keyboard accessible: use `Tab` to reach it,
`Enter` or `Space` to navigate, and `Escape` to close it. On narrow screens it
opens as a local overlay and closes after navigation. Its open/closed state is
UI-only and is not saved with the document.

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

Fast unit, storage-contract, and editor-persistence tests run with Node's built-in test runner:

```bash
npm run test:fast
```

The fast suite includes a compact seeded reference-model test. Re-run one failing model seed with bounded steps using:

```bash
LAB_MODEL_SEED=0x5eedc0de LAB_MODEL_STEPS=64 npm run test:model
```

The Chromium suite uses real localStorage, IndexedDB, and OPFS. Install the browser once, then run:

```bash
npx playwright install chromium
npm run test:e2e
```

`test:e2e` excludes the opt-in repeated concurrency stress case. Run it with a reproducible seed and bounded iteration count when investigating scheduling failures:

```bash
LAB_STRESS_SEED=0x20260802 LAB_STRESS_ITERATIONS=8 npm run test:stress
```

Stress failures print the seed, iteration, and schedule; replay the same seed with `LAB_STRESS_ITERATIONS` set through the failing iteration. The quota contract tests use standards-shaped `QuotaExceededError` failures for each backend. Chromium CDP quota override is covered once for the reliable IndexedDB/OPFS path; localStorage is intentionally kept at the contract layer because Chromium 140 does not apply that override to it.

`npm run verify` runs the fast suite, Chromium E2E, lint, typecheck, and production build.

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

The original note remains the default, so existing users do not need to manage documents. Use `/new` to start a separate local document, `/name` to give the current document a recognizable name, `/sessions` to resume another document, and `/delete` to permanently remove an extra session (the original cannot be deleted; use `/clear` to empty it).

Each session has its own URL hash and isolated redundant storage. Different sessions can stay open and save independently in different tabs. Two tabs opened to the same session still use atomic conflict resolution, with the losing edit retained for `/recover` rather than silently discarded.

Use `/search` (or type `/find`) to search session names and the text of every local session. Results include a short excerpt and open the matching session with Enter or a click. Search reads verified on-device snapshots only; it makes no network requests and does not create a new remote index.

## Math

Type `$$...$$` to turn an inline expression into KaTeX-rendered math. Use
`/math` (or `/latex`) for a centered block equation. Equations remain local,
editable, and round-trip through Markdown import/export.
