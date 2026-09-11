# Architecture

Nested is a Tauri 2 desktop app. The window is a React + TypeScript webview; the Rust side owns the filesystem, the Keychain and the network.

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

Settings are stored in the app config directory as `settings.json`, and the Home screen's list of recent sessions as `recents.json` beside it (folder, optional file, name, last opened, unread count). API keys are stored in the macOS Keychain under the service `app.nestedreader.nested`, the bundle identifier, one entry per provider. The app first shipped as `com.truefrontier.markdown-learner`; the first launch under the new identifier copies `settings.json`, `recents.json` and the keys across (`src-tauri/src/migrate.rs`) and leaves the old copies in place. The frontend never holds a key after saving it; Rust reads it when it makes a request.

## Home and sessions

Home replaces the window: recent sessions on the left, the ways to start one on the right. The ‹ beside the session title in the sidebar (⌘⇧H) steps up to it; the open session stays loaded, so leaving Home (Esc, or clicking that session) lands exactly where you were. Clicking another recent session loads that folder and restores its saved session.

A session is either a **folder** (every `.md` under it) or a **file**. Both come from the one Open panel behind ⌘O (`pick_path`, an NSOpenPanel in `src-tauri/src/open_panel.rs` that takes a folder or a `.md`, which the dialog plugin cannot do in one panel) or from a drop; `path_kind` decides which kind the path is. A file session lists only that page and the pages whose `source` chain leads back to it (`growsFrom` in `src/lib/tree.ts`); new pages are still written beside the file, so the folder stays the unit on disk and the session keeps its own `session-<page>.json`. Drops arrive through the webview's drag-drop events; `path_kind` tells the frontend whether a path is a folder, a Markdown file, or neither.

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

`source` is the parent. `mode` is `new-page` (opened in the foreground) or `deep-dive` (opened in the background, marked unread). The sidebar hangs every page under its `source`, whatever its mode, so it shows the same tree as the Web map: pages with no source (or a source that is not in the folder) newest first, and under each one its children oldest first. The Timeline map is the same list with times.

The sidebar also shows the folder's directories. `buildFolders` in `src/lib/tree.ts` nests them as on disk; inside each, subfolders come first by name and then that directory's own pages as the source tree above (`buildTree` over just those pages, so a page whose source sits in another directory is a root of its own). Only directories holding pages are listed. A folder row's chevron closes or opens it; closed folders are kept in `session.collapsed` (paths relative to the session folder), so they survive a reopen. Opening a page inside a closed folder opens the folder (`revealInTree`), and while the Filter box or a filter dot is in use every folder is open and one with nothing to show is left out. The filter matches a page's title or its path, so typing a folder name finds its pages. Beside the box sit up to two filter dots, one per mark: the blue dot (`ui.unreadOnly`) keeps only unread pages, with those still being written or that failed to write, and the green ring (`ui.changesOnly`) keeps only pages with changes to review; with both on a page showing either mark is listed. Each dot is offered only while some page carries its mark, and a filter whose last page is gone switches itself off (`clearTreeFilter`), so the tree never sits empty behind it.

A value that needs quoting (a title with a colon or a quote in it) is written as a JSON string and parsed back the same way, so quotes inside a title survive the round trip instead of showing as `\"`.

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

## Appearance

Theme, text size, reading font and page width are settings. `applyTheme` in the store writes them to the root element as `data-theme`, `--text-size`, `data-font` and `--reading-width`, at launch and again whenever the settings window saves. The reading column (`.article`) takes `--reading-width` as its `max-width`. The unit is `em`, measured against the article's own text, so the column follows the text size and comes out a little narrower in the split pane, whose text is 1px smaller; or `%` of the pane. The setting keeps a value per unit (`readingWidth: { unit, em, percent }`), so switching units brings back the last choice made in each. The default is 33em, the old 560px at 17px text, so an upgrade moves nothing. Values outside 20–60em or 30–100% are clamped when applied.

The sidebar's width is dragged, not typed: its right edge (`.side-grip`) resizes it, double-click puts it back to 224px, and the result is saved as `sidebarWidth` with the other settings and applied as `--side-width`, clamped to 180–480px. While the pointer is down the store only previews the variable; the setting is written once when it is let go.

The window chrome (traffic lights, the tree toggle, the pane tools and the review strip) floats over the reading panes rather than taking a row of its own. A 64px strip at the top of `.main` (`.main::before`) paints the background solid for 40px and then fades out, so scrolled text dims and disappears under the chrome instead of running through it. It ignores pointer events, so the scrollbar and the drag region underneath still work.

Settings is its own window in the app (⌘, or the app menu) and a panel over the reader in the browser build. Either closes on Esc, ⌘W, or a click outside it: the panel from its backdrop, the window when it loses focus (`onFocusChanged` in `SettingsApp`), except while the folder picker it opened is up. ⌘W is a menu accelerator (File › Close Pane), so `lib.rs` closes the settings window when that item fires with the window in front. Esc inside a text box only leaves the box; a second Esc closes.

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

## Highlights in either pane

A highlight belongs to the pane it was dragged in: `ui.selection.pane` (and `ui.lookup.pane` for the answer card) holds the pane role, and each `Page` draws the `.sel` wrap, the ask or refine box, the status card and the answer card only for its own role. The verbs act on that pane's page, read through `panePath`: a New Page or Deep Dive asked from the split pane hangs off the split page and the `[[slug|text]]` link lands there, and a selection or page refine from the split rewrites the split page. The pane-level box (⌘R with nothing highlighted, ⌘N) still works on the main page. When the split pane's page changes (`openPage` beside or below) or the pane closes, `dropPaneUi` drops a highlight or answer card that sat there; navigating the main pane resets the whole `ui` as before.

A Quick Answer is not lost when its card closes. Once the answer has streamed in (or a partial one is closed early), `rememberLookup` files it under the page in `session.asks`, keyed on the highlighted text and its block, so a follow-up replaces the earlier exchange instead of adding a second entry. The page draws each remembered ask as an `.asked` wrap, a dotted line under the text, re-finding the text with `flexiblePattern` when a refine has moved it and hiding the ask when the text is gone. Hovering the dotted text peeks at the card (`showAsk` with `peek`, which also sets the highlight); the card closes shortly after the pointer leaves both the text and the card, and a click pins it so a follow-up can be typed. After Esc the text does not peek again until the pointer has left it once.

## Versions in either pane

`versions` and `versionBodies` in the store are keyed by page path, and `ui.versionView` holds one `{ history, viewing, confirmRestore }` per pane role (`main`, `split`). So each pane shows the version pill for its own page and can view, and restore from, an old version on its own; the same page can sit in both panes at two different versions. `toggleHistory`, `viewVersion`, `backToCurrent`, `askRestore`, `cancelRestore` and `restore` take the pane role and read the page from `session.current` or `session.split`. Esc closes the reading pane's history menu or version view first (the split when it is fullscreen, else the main pane), then the other's. A restore drops every newer snapshot, so a pane showing one of them on the same page returns to current too.

A version in the menu is a link like any other: ⌘Click and ⌘⇧Click pass the New Page and Deep Dive placement settings (via `placementFor`) to `viewVersion`. "beside" and "below" put the page in the other pane and view the version there (from the split's menu, the other pane is the main one). "window" opens a page window at that version: the window URL carries `&version=N`, which `init` hands to `openFolder` as `initialVersion`. "background" means nothing for a version, so it views the version in place like a plain click.

When both panes show the same page they scroll together: `useSyncScroll` (used by `App`) links the two `.pane` scroll containers in proportion, since the split renders the same text a little shorter. The split pane's tools show a link button, lit while `ui.syncScroll` is on; clicking it turns the link off and on. Opening a page beside or below turns it back on.

## Find and filter

`ui.find`, `ui.findQuery` and `ui.findIndex` describe the find bar; the page being read (the main pane, or the split when it is fullscreen) matches the query case-insensitively against each block's text, wraps the hits with `.fnd` (the current one `.fnd.cur`) through the same `applyWraps` path as selections and change tints, and scrolls the current hit into view. `findIndex` only counts steps; the page wraps it around the match count, so ⌘G keeps working across pages with different counts. ↵ in the box and every step also bump `ui.findSelect`; the page being read answers by measuring the current hit and calling `selectMatch`, which makes it the selection and opens the ask box (or the refine box, if that was open), so a question can follow a search without the mouse. ⌘F, ⌘G, ⌘⇧G and ⌘/ are handled in the webview (like ⌘R) so they work while a box has focus; the menu items carry the keys in their labels. `/` outside any box, or ⌘/, shows the tree and focuses its Filter box via `ui.filterFocus`.

## Clicks, marks and pages that failed to generate

A plain click on a link or tree row opens the page here. ⌘‑click uses the "⌘‑click opens" setting (`newPageOpens`, also where New Page ⌘↵ goes) and ⌘⇧‑click the "⌘⇧‑click opens" setting (`deepDiveOpens`, also where Deep Dive ⌘⇧↵ goes); ⌥ flips either (`placementFor` in the store). For a page that already exists, the "background" placement is a read‑later mark: it adds the page to `session.unread`, and doing it again removes it. Both settings sit under General.

The sidebar and map carry three marks: a solid blue dot for unread (`.udot`), a green ring for changes to review (`.cdot`, matching the strip's ring), and an amber dot for a page the model failed to write (`.fdot`).

## New page from the session (⌘N)

⌘N opens the same bottom box as a page or corpus refine (`ui.panePopover` is `"refine"` or `"new"`), from the File menu item, the button at the foot of the tree, or the key, which stays in the webview like ⌘R so it also works while the ask box has focus. The brief typed there is the page's `question`; `newFile` in the store calls `createPage` with `from: "session"` and no highlight, so nothing is linked in the source. The page's `source` is the page you were reading, which keeps it inside the session (and inside a file session). ↵ opens it here, ⌘↵ follows the New Page placement, ⌘⇧↵ writes a Deep Dive at its placement, ⌥ flips either.

`generatePage` then uses `newFileMessages` instead of `newPageMessages`: the current page plus the session and folder pages the Context toggles allow, and the brief as "New page: …". A retry tells the two apart by whether the source page holds a `[[slug|text]]` link to the page; a page with no link was started from the session.

Page generation is `generatePage` in the store, separate from creating the file. A failed stream leaves the page with its heading, records the message in `pageErrors`, and toasts if the page is not on screen. The page then shows a card with Try again (↵), and so does any page that holds only its heading. `retryPage` rebuilds the context from the source page by finding the `[[slug|text]]` link to the page, then streams again.
