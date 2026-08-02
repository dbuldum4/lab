# lab

A local-only, local-first Markdown notepad. There is no toolbar: type `/` in an empty line to open every command.

## Run locally

Requires Node.js 22.6 or newer.

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Deploy

Pushes to `main` deploy a static export to GitHub Pages at
`https://dbuldum4.github.io/lab/`.

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

`lab` has no accounts, analytics, API routes, or remote assets. Its Content Security Policy only permits same-origin connections. Notes stay local to the browser and are written redundantly to localStorage, IndexedDB, and the browser's origin-private file system when available. Integrity checks detect accidental or corrupted snapshots; they are not encryption, so this app does not promise encrypted at-rest storage.

Use `/export` for a portable Markdown copy and `/import` to restore one.
