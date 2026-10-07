# lab for macOS and Linux

A native build of lab, written in Rust with [GPUI](https://www.gpui.rs), the
UI framework behind the Zed editor. It keeps the web app's look and its slash
commands, and stores notes as plain files on your computer.

## Run it

You need a current stable Rust toolchain (`rustup update stable`).

```bash
cd desktop
cargo run --release
```

On Linux, install the libraries GPUI links against first. On Debian or
Ubuntu:

```bash
sudo apt-get install pkg-config libfontconfig-dev libfreetype-dev \
  libxcb1-dev libxkbcommon-dev libxkbcommon-x11-dev
```

The app draws with Metal on macOS and Vulkan on Linux. Shaders compile when
the app starts, so the Xcode command line tools are enough on macOS.

## What is the same

- The editor column, typography, and all 21 themes come from the web app's
  stylesheet. Geist and Geist Mono are bundled.
- Type `/` to open the command palette. Every web command is here except
  recovery drafts and the image metadata dialog (see below).
- The keyboard shortcuts match: `Cmd+K` on macOS or `Ctrl+K` on Linux opens
  sessions, `Cmd/Ctrl+/` lists the rest. On macOS the menu bar also lists
  the commands, with their shortcuts.
- Sessions, pins, archives, search, backlinks, statistics, the outline, and
  version history behave as they do on the web.
- `/backup` writes the same `lab-vault-backup.json` format, so a backup from
  either app restores in the other.

## What is different

**You edit Markdown directly.** The web app hides Markdown behind a rich
editor. Here the Markdown is the text you type. It is styled as you go:
headings are large, syntax marks are quiet, and code, quotes, and callouts
sit in their own frames. Tables and images show as a grid and a picture
until you click into them. Enter starts a new paragraph; Shift+Enter
breaks the line.

**Notes are files.** The vault lives in `~/Library/Application Support/lab`
on macOS and `~/.local/share/lab` on Linux. Set `LAB_VAULT_DIR` to use
another folder. Each note is `notes/<id>.md`; images live in `assets/`.
`/status` shows the folder, and Enter opens it.

```text
vault.json            session names, pins, archives, and the theme
notes/<id>.md         one Markdown file per session
history/<id>.json     up to 50 versions, 1 MiB per session
assets/<id>.<ext>     images, stored once by content hash
```

Every write goes to a temporary file that is synced and then renamed into
place. A crash leaves the old file or the new one, never half of each. The
web app copies each note into three browser stores to survive storage
eviction; a file system does not evict, so one atomic copy is enough.
A note file that `vault.json` does not list, such as one from a restore
interrupted by quitting, is added back to your sessions the next time the
app starts.

**One window owns the vault.** A second copy of the app refuses to start
rather than risk two writers. That is why the web app's `/recover` command,
which exports drafts from conflicting browser tabs, is not needed.

**History is calmer.** The web app saves a version after every pause in
typing. Here a version is saved at most once a minute while you write, and
always before `/clear`, `/import`, or restoring an older version.

**Images are files, not text.** Paste an image or use `/image`, and the note
refers to it as `lab-asset://…`. `/export` turns those references back into
embedded `data:` images, so the exported `.md` file stands alone. Edit alt
text by clicking the image to reveal its Markdown.

**Math stays as source.** `$$…$$` is shown in a monospaced style but is not
typeset. The Markdown is unchanged, so it renders wherever you export it.

## Develop

```bash
cargo fmt
cargo clippy --all-targets -- -D warnings
cargo test
```

The code is in `src/`:

| File | Purpose |
| --- | --- |
| `main.rs` | Starts GPUI, loads fonts, opens the window |
| `menus.rs` | The menu bar and its window and app actions |
| `app.rs`, `app_commands.rs` | Palette state and every slash command |
| `ui.rs` | Palette panels, outline, and notices |
| `editor/` | The Markdown editor: text, input, layout, and painting |
| `vault.rs`, `backup.rs` | Files on disk and the portable backup format |
| `commands.rs`, `search.rs`, `markdown_info.rs`, `text_ops.rs` | Logic shared with the web app, with unit tests |
| `theme/` | The 21 themes, generated from `app/globals.css` |

GPUI comes from the `gpui-pre` crate, a weekly snapshot of Zed's GPUI
published to crates.io. Pin changes deliberately: GPUI's API moves quickly.

## Licenses

Theme colours are adapted from the projects listed in
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). Geist and Geist Mono are
© Vercel and licensed under the SIL Open Font License; see
[assets/fonts/OFL.txt](assets/fonts/OFL.txt).
