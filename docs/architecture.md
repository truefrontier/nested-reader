# Architecture

Markdown Learner is a Tauri 2 desktop app. The window is a React + TypeScript webview; the Rust side owns the filesystem, the Keychain and the network.

## The idea in one paragraph

A session is a folder of `.md` files. You read one page at a time. Highlighting text is the only creation gesture: it offers three verbs. **Quick Answer** puts a short answer inline. **New Page** writes a new `.md` file beside the source and opens it in a split pane. **Deep Dive** writes a longer page in the background and marks it unread in the tree. Every new page records its source in front matter, so the folder itself is the session map. **Refine** rewrites a selection, a page, or the whole session; the file is written immediately and the changes are shown tinted so you can undo any of them. Every refine snapshots the previous text as a numbered version.

## Layout

```
src/                     React app (both windows)
  platform/              backend contract + two implementations
    types.ts             Page, Session, Settings, AI request/stream types
    tauri.ts             invoke() bridge to the Rust commands
    mock.ts              in-memory backend for the browser (pnpm dev)
  state/store.ts         the reader store: every action lives here
  lib/                   pure helpers: markdown, diff, front matter, tree, prompts
  reader/                Sidebar, Page, TopStrip, Popovers, SplitPane, MapOverlay
  settings/              the Settings window (General / Appearance / AI)
  styles/                design tokens, fonts, reader and settings CSS
src-tauri/src/
  lib.rs                 commands, menu bar, window creation
  files.rs               pages, session.json, versions (atomic writes)
  ai.rs                  streaming for OpenAI, Anthropic, Ollama and OpenAI-compatible APIs
  cli.rs                 plan access through the claude and codex command-line tools
examples/sleep-memory/   sample corpus used by the mock backend
design/                  Claude Design source files this app implements
```

## What lives on disk

Everything about a session stays inside the folder you opened.

| Path | Purpose |
| --- | --- |
| `*.md` | Pages. New pages carry front matter: `title`, `source`, `question`, `created`, `mode`. |
| `.reader/session.json` | Current page, read/unread state, trail, split, pending reviews. |
| `.reader/versions/<page>/vN.md` | Snapshots taken before each refine. The live file is always the newest version. |

Settings are stored in the app config directory as `settings.json`. API keys are stored in the macOS Keychain under the service `com.truefrontier.markdown-learner`, one entry per provider. The frontend never holds a key after saving it; Rust reads it when it makes a request.

## Front matter and links

A page grown from another page looks like this:

```
---
title: Sharp-wave ripples
source: replay-into-cortex.md
question: What is a sharp-wave ripple?
created: 2026-09-10T09:42:00
mode: new-page
---
```

`source` is the parent. `mode` is `new-page` (opened in the foreground, part of the trail) or `deep-dive` (opened in the background, a branch under its parent). The sidebar lists trail pages newest first and hangs branches under their parent; the Timeline map is the same list with times.

When a page is created from a highlight, the highlighted words in the source are wrapped as `[[slug|highlighted words]]`. The display text is unchanged, Obsidian understands the link, and the reader renders it underlined with a dot while the target is loading or unread.

## Refine, review, history

1. Refine sends the selection (or page) with an instruction and gets back replacement text.
2. The current file is copied to `.reader/versions/<page>/vN.md`, then the file is overwritten.
3. `session.json` records `pending[page] = N`. The review UI diffs version N against the live file at the word level; each changed span is tinted, hovering shows the old text with **Undo**. Undo rewrites the file; **Undo all** restores version N and deletes the snapshot; **Done** just clears the marks.
4. Later, the version pill lists snapshots. Viewing an old version shows its text with the spans that differ from today tinted amber; **Restore** writes it back and drops every newer snapshot, after a confirmation.

Diffing happens in TypeScript on the rendered text of each block (`src/lib/diff.ts`), so Rust never needs to understand Markdown.

## AI

`ai_stream` takes a provider, model, optional base URL, a system prompt and messages, and streams deltas back over a `tauri::ipc::Channel`. Providers:

- **OpenAI**: `POST {base}/chat/completions` with `stream: true`.
- **Anthropic**: `POST /v1/messages` with `stream: true`.
- **Ollama**: `POST {server}/api/chat` with `stream: true` and `think: false`, read as newline-delimited JSON; `GET {server}/api/tags` for the ping and the installed-model list (chat models only, local and smallest first). No key; the server URL is `ollamaUrl` in settings. The client has no overall timeout because local models can be slow.
- **Custom**: any OpenAI-compatible server; set the base URL in Settings.
- **Plans** (`auth: "subscription"` on the request, `cli.rs`): Anthropic runs `claude -p --output-format stream-json --include-partial-messages --tools "" --setting-sources "" --strict-mcp-config` from a neutral folder and forwards `text_delta` events; OpenAI runs `codex exec --json` and forwards `agent_message` items. The pings are `claude auth status --json` and `codex login status`. The CLIs hold the sign-in; the app never handles a token.

Every ping returns the provider's model list (`PingResult.models`). Settings shows it as a menu and, when nothing has been chosen for that provider and account mode, picks the cheapest tier it recognises (`src/lib/models.ts`: Luna, nano or mini for OpenAI; Haiku for Anthropic; the smallest local model for Ollama; the CLI aliases for plans).
- **Built in** is present in the UI but not wired to a service in this build.

Prompts are built in `src/lib/prompts.ts`. What gets sent is controlled by the Context toggles in Settings: the highlight and its paragraph, the other pages in this session, or every page in the folder.

## Running it

```
pnpm install
pnpm tauri dev        # the app
pnpm dev              # browser-only preview with the mock backend
pnpm tauri build      # .app and .dmg in src-tauri/target/release/bundle
```
