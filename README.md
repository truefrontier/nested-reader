# Markdown Learner

A calm research reader for a folder of Markdown notes. Built with Tauri 2, React and Rust for macOS.

Read a page. Select text to ask about it. **Quick Answer** puts a short answer inline. **New Page** writes a new `.md` beside the source and opens it in a split pane. **Deep Dive** writes a longer page in the background and marks it unread. **Refine** (⌘R) rewrites a selection, a page, or the whole session; changes are tinted so you can undo any one of them, and every refine keeps the previous text as a version.

Every page is a plain `.md` file in the folder you opened. Nothing else is required to read your notes elsewhere.

## Run

```bash
pnpm install
pnpm tauri dev
```

`pnpm dev` runs the reader in a browser with an in-memory sample folder, useful for UI work without the Rust side.

`pnpm tauri build` produces the `.app` and `.dmg` under `src-tauri/target/release/bundle/`.

## Set up a provider

Open Settings (⌘,) › AI. Pick OpenAI, Anthropic, Ollama, or Custom (any OpenAI-compatible server; set its base URL). For OpenAI, Anthropic and Custom, paste an API key and press ↵; it is stored in the macOS Keychain. The model field shows a live connection check. The Context toggles decide what leaves the machine with each request.

Ollama needs no key. Point the Server field at your Ollama instance (default `http://localhost:11434`); the Model field then offers the models you have pulled, and nothing leaves the machine.

The "Built in" provider is in the design but not connected to a service in this build.

## Shortcuts

| Keys | Action |
| --- | --- |
| ↵ / ⌘↵ / ⌘⇧↵ | Quick Answer / New Page / Deep Dive from the ask popover |
| ⌥ + verb | Use the other placement (beside ↔ background) |
| ⌘R | Refine the selection, or the page when nothing is selected |
| ⌘\ | Toggle the tree |
| ⌘K | Session map |
| ⌘⇧F | Fullscreen the split pane |
| ⌘[ / ⌘] | Back / forward along the trail |
| ⌘O | Open a folder |
| Esc | Dismiss |

Link clicks follow browser habits: click opens here, ⌘-click loads in the background, ⌘⇧-click opens here, ⌥-click opens beside.

## Layout

See [docs/architecture.md](docs/architecture.md) for how the pieces fit, what is written to disk, and how refine, review and versions work. The Claude Design source files the app implements are in `design/`.
