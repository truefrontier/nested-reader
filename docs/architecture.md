# Architecture

Markdown Learner is a Tauri 2 desktop app. The window is a React + TypeScript webview; the Rust side owns the filesystem, the Keychain and the network.

## The idea in one paragraph

A session is a folder of `.md` files. You read one page at a time. Highlighting text is the only creation gesture: it offers three verbs. **Quick Answer** puts a short answer inline. **New Page** writes a new `.md` file beside the source and opens it in a split pane. **Deep Dive** writes a longer page in the background and marks it unread in the tree. Every new page records its source in front matter, so the folder itself is the session map. **Refine** rewrites a selection, a page, or the whole session; the file is written immediately and the changes are shown tinted so you can undo any of them. Every refine snapshots the previous text as a numbered version. **New page** (⌘N) takes a brief instead of a highlight and writes a fresh `.md` from the whole session.

## Layout

```
src/                     React app (both windows)
  platform/              backend contract + two implementations
    types.ts             Page, Session, Settings, AI request/stream types
    tauri.ts             invoke() bridge to the Rust commands
    mock.ts              in-memory backend for the browser (pnpm dev)
  state/store.ts         the reader store: every action lives here
  lib/                   pure helpers: markdown, diff, front matter, tree, prompts
  reader/                Home, Sidebar, Page, TopStrip, Popovers, SplitPane, MapOverlay
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
| `.reader/session.json` | Current page, read/unread state, trail, split, pending reviews, and a display name if the session was renamed. |
| `.reader/session-<page>.json` | The same, for a session opened from a single file in this folder. |
| `.reader/versions/<page>/vN.md` | Snapshots taken before each refine. The live file is always the newest version. |

Settings are stored in the app config directory as `settings.json`, and the Home screen's list of recent sessions as `recents.json` beside it (folder, optional file, name, last opened, unread count). API keys are stored in the macOS Keychain under the service `com.truefrontier.markdown-learner`, one entry per provider. The frontend never holds a key after saving it; Rust reads it when it makes a request.

## Home and sessions

Home replaces the window: recent sessions on the left, the ways to start one on the right. The ‹ beside the session title in the sidebar (⌘⇧H) steps up to it; the open session stays loaded, so leaving Home (Esc, or clicking that session) lands exactly where you were. Clicking another recent session loads that folder and restores its saved session.

A session is either a **folder** (every `.md` under it, `pick_folder` or a dropped folder) or a **file** (`pick_file`, ⌘⇧O, or a dropped `.md`). A file session lists only that page and the pages whose `source` chain leads back to it (`growsFrom` in `src/lib/tree.ts`); new pages are still written beside the file, so the folder stays the unit on disk and the session keeps its own `session-<page>.json`. Drops arrive through the webview's drag-drop events; `path_kind` tells the frontend whether a path is a folder, a Markdown file, or neither.

At launch, `openAtLaunch: "last-session"` reopens the first entry of `recents.json` (so a file session comes back as one), `"ask"` shows the folder picker, and `"nothing"` or a cancelled picker leaves you on Home.

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

## Refine and review state

A refinement snapshots the page (`.reader/versions/<page>/vN.md`), writes the new body and records `session.pending[path] = n`. `reviewBases` in the store holds, per path, the snapshot each pending page is reviewed against, so any pane showing that page (main or split) renders the tints and its own strip with Undo all and Done. `done(path)`, `undoAll(path)` and `undoChange(change, path)` act on one page. A corpus refine therefore leaves every touched page pending until each is reviewed; the sidebar dot follows `session.pending`.

While a refinement runs, `ui.refining` and `ui.refineText` drive a status card in the place of the refine box (in the page for a selection, at the pane's bottom for page and corpus scope). A failure sets `ui.refineError` and keeps the selection and text, so the card offers Try again. The ask and refine boxes share the typed draft, held by the page, across the ⌘R switch.

## Clicks, marks and pages that failed to generate

A plain click on a link or tree row opens the page here. ⌘‑click uses the "⌘‑click opens" setting (`newPageOpens`, also where New Page ⌘↵ goes) and ⌘⇧‑click the "⌘⇧‑click opens" setting (`deepDiveOpens`, also where Deep Dive ⌘⇧↵ goes); ⌥ flips either (`placementFor` in the store). For a page that already exists, the "background" placement is a read‑later mark: it adds the page to `session.unread`, and doing it again removes it. Both settings sit under General.

The sidebar and map carry three marks: a solid blue dot for unread (`.udot`), a green ring for changes to review (`.cdot`, matching the strip's ring), and an amber dot for a page the model failed to write (`.fdot`).

## New page from the session (⌘N)

⌘N opens the same bottom box as a page or corpus refine (`ui.panePopover` is `"refine"` or `"new"`), from the File menu item, the button at the foot of the tree, or the key, which stays in the webview like ⌘R so it also works while the ask box has focus. The brief typed there is the page's `question`; `newFile` in the store calls `createPage` with `from: "session"` and no highlight, so nothing is linked in the source. The page's `source` is the page you were reading, which keeps it inside the session (and inside a file session). ↵ opens it here, ⌘↵ follows the New Page placement, ⌘⇧↵ writes a Deep Dive at its placement, ⌥ flips either.

`generatePage` then uses `newFileMessages` instead of `newPageMessages`: the current page plus the session and folder pages the Context toggles allow, and the brief as "New page: …". A retry tells the two apart by whether the source page holds a `[[slug|text]]` link to the page; a page with no link was started from the session.

Page generation is `generatePage` in the store, separate from creating the file. A failed stream leaves the page with its heading, records the message in `pageErrors`, and toasts if the page is not on screen. The page then shows a card with Try again (↵), and so does any page that holds only its heading. `retryPage` rebuilds the context from the source page by finding the `[[slug|text]]` link to the page, then streams again.
