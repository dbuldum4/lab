# lab

A private, local-first Markdown notepad. There is no toolbar: type `/` in an empty line to open every command.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Privacy

`lab` has no accounts, analytics, API routes, or remote assets. Its Content Security Policy only permits same-origin connections. Notes are checksummed and written redundantly to localStorage, IndexedDB, and the browser's origin-private file system when available.

Use `/export` for a portable Markdown copy and `/import` to restore one.
