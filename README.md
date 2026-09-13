# Nested

A calm research reader for a folder of Markdown notes. Built with Tauri 2, React and Rust for macOS.

Read a page. Select text to ask about it. **Quick Answer** puts a short answer inline; after it closes, the text keeps a dotted line and hovering it shows the answer again. **New Page** writes a new `.md` beside the source and opens it in a split pane. **Deep Dive** writes a longer page in the background and marks it unread. **Refine** (⌘R) rewrites a selection, a page, or the whole session; changes are tinted so you can undo any one of them, and every refine keeps the previous text as a version. **New page** (⌘N) is the same reach with a blank file: type what the page should cover and it is written from the whole session, with no highlight behind it.

Every page is a plain `.md` file in the folder you opened. Nothing else is required to read your notes elsewhere.

**Home** is one level up from a session: the ‹ beside the session title (or ⌘⇧H) shows your recent sessions and the way to start one. **Open…** (⌘O) takes a folder, so every `.md` inside is the corpus, or a single `.md`, so pages you create are saved next to it. Dropping a folder or file anywhere in the window does the same. **Add to Session…** (⌘⇧O) brings another folder or file into the open session: its pages join the tree under a header of their own, the model sees them like any other page, and the ··· menu on that header takes them out again. Clicking a recent session returns you to it where you left off; its ··· menu can rename it, reveal it in Finder, open its map, or drop it from the list.

## Run

```bash
pnpm install
pnpm tauri dev
```

`pnpm dev` runs the reader in a browser with an in-memory sample folder, useful for UI work without the Rust side.

`pnpm tauri build` produces the `.app` and `.dmg` under `src-tauri/target/release/bundle/`.

## Install and update

The newest build is always at **https://nested-feedback.fly.dev/updates/dmg**: open the `.dmg`, drag Nested to Applications. After that the app keeps itself current. A few seconds after it opens (and every few hours while it runs) it asks for a newer version; when there is one, a quiet card at the foot of the window says so, and **Update and relaunch** downloads it, swaps it in and starts the app again. **Later** puts it off until the next launch. To look right now, use **Nested › Check for Updates…** in the menu, or the Updates row in Settings › General, which also shows the version you are on. Under `pnpm tauri dev` nothing can be swapped in, so both say updates arrive in the built app.

Publishing a version is one command from a clean `main`:

```bash
pnpm release 0.2.0     # or: pnpm release patch | minor | major
```

It writes the version into `package.json`, `tauri.conf.json`, `Cargo.toml` and `Cargo.lock`, commits, tags `v0.2.0` and pushes. GitHub Actions ([`release.yml`](.github/workflows/release.yml)) then builds a universal Mac app, signs the updater bundle, and publishes a GitHub Release with the `.dmg`, the bundle, and `latest.json`. The repository is private, so installed copies do not read the release directly: the relay in [`feedback-relay/`](feedback-relay/README.md) serves `latest.json` and the downloads with its own token. The Actions workflow needs the updater's private key as the `TAURI_SIGNING_PRIVATE_KEY` secret; its public half is in `tauri.conf.json`.

## Opening pages

Click a link or a tree row to open the page here. ⌘‑click opens it beside (the default for "⌘‑click opens", which New Page ⌘↵ shares), and ⌘⇧‑click marks it unread to read later, or read again if it already was (the default for "⌘⇧‑click opens", shared with Deep Dive ⌘⇧↵). Hold ⌥ for the other placement. Both are under Settings › General. In the tree, a blue dot means unread, a green ring means changes to review, and an amber dot means the page failed to generate; open it and press ↵ to try again. Hover a row for its ⋯ menu (or right‑click it) to mark the page unread, or read again.

**From Finder.** The built app registers as an app for `.md` files, so a double‑click, Open With, or a drop on the Dock icon opens the file as a session here; if the app is not running, that file wins over "Open at launch". To make Nested the default for Markdown, use Settings › General › Markdown files (the Home screen offers it once, too). macOS may ask you to confirm, and the switch needs the built `Nested.app` (a copy in Applications is best), not `pnpm tauri dev`.

## Send feedback

The quiet **Send feedback** link at the bottom of the tree opens a box for a bug, an idea, anything. ⌘↵ sends it (↵ makes a new line); an email address is optional and only used to reply. The note lands as an issue on this repository, labelled `feedback`, where a Claude workflow reads it against the code and leaves a triage note. The app never holds a GitHub token: it posts to the small relay in [`feedback-relay/`](feedback-relay/README.md), and the relay's URL is compiled in from `src-tauri/.cargo/config.toml`. Until that is set, the box says feedback is not set up in this build.

## Set up a provider

Open Settings (⌘,) › AI. Pick OpenAI, Anthropic, Ollama, or Custom (any OpenAI-compatible server; set its base URL). With an API key, paste it and press ↵; it is stored in the macOS Keychain. The Model menu lists what the provider offers and starts on its fastest, cheapest option (Luna for OpenAI, Haiku for Anthropic). The status next to it is a live connection check. The Context toggles decide what leaves the machine with each request.

**Use a plan instead of a key.** Under OpenAI or Anthropic, switch Account to "ChatGPT plan" or "Claude plan". The app then runs the official command-line tool signed in on your Mac (`codex exec` or `claude -p`) and questions count against that plan. Sign in once in a terminal with `codex login` or `claude` › `/login`.

**Let it look things up.** With "Let the model read the folder itself" on (Settings › AI › Tools, on by default), the model can list, read and search the pages of the open folder while it answers, instead of relying only on the context sent with the question. The card or page says what it is reading ("Reading sharp-wave-ripples.md…") until the text starts. The tools are read-only and never reach outside the folder. Under a plan, the official CLI gets the same reach: Claude Code with its Read, Grep and Glob tools pointed at the folder, Codex with its read-only sandbox in the folder.

**Ollama** needs no key. Point the Server field at your Ollama instance (default `http://localhost:11434`); the Model menu then lists the models you have pulled, smallest first, and nothing leaves the machine.

The "Built in" provider is in the design but not connected to a service in this build.

## Shortcuts

| Keys | Action |
| --- | --- |
| ↵ / ⌘↵ / ⌘⇧↵ | Quick Answer / New Page / Deep Dive from the ask popover |
| ⌥ + verb | Use the other placement (beside ↔ background) |
| ⌘R | Refine the selection, or the page when nothing is selected |
| ⌘N | New page written from the whole session: ↵ here, ⌘↵ New Page placement, ⌘⇧↵ Deep Dive |
| ⌘F | Find in the page; a fresh selection becomes the search |
| ↵ in the find box | Select the match: the ask box opens on it, ready to type |
| ⌘G / ⌘⇧G | Next / previous match, selected the same way (⌘R switches to refine) |
| / or ⌘/ | Filter the tree (shows it if hidden); Esc clears, then leaves the box |
| ⌘B | Toggle the tree |
| ⌘K | Session map |
| ⌘⇧F | Fullscreen the split pane |
| ⌘[ / ⌘] | Back / forward along the trail |
| ⌘O | Open a folder or a single file |
| ⌘⇧O | Add a folder or file to the open session |
| ⌘⇧H | Home (recent sessions) |
| Esc | Dismiss, or leave Home |

Link clicks follow browser habits: click opens here, ⌘-click loads in the background, ⌘⇧-click opens here, ⌥-click opens beside.

## Layout

See [docs/architecture.md](docs/architecture.md) for how the pieces fit, what is written to disk, and how refine, review and versions work. The Claude Design source files the app implements are in `design/`.
