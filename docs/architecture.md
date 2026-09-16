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
  feedback.rs            the Send feedback note, posted to the relay
  updater.rs             check for, download and install a newer version
  tauri.release.conf.json  overlay for CI builds: turns on the signed updater bundle
feedback-relay/          relay (Cloudflare Worker or Fly): files feedback as GitHub issues, serves app updates
scripts/release.mjs      pnpm release: bump the version everywhere, commit, tag, push
.github/workflows/       Claude on GitHub: @claude replies, PR review, feedback triage; release.yml builds and publishes tags
examples/sleep-memory/   sample corpus used by the mock backend
design/                  Claude Design source files this app implements
```

## What lives on disk

Everything about a session stays inside the folder you opened.

| Path | Purpose |
| --- | --- |
| `*.md` | Pages. New pages carry front matter: `title`, `source`, `question`, `created`, `mode`. |
| `.reader/session.json` | Current page, read/unread state, trail, split, pending reviews, a display name if the session was renamed, and `ids` (Unix `dev:ino` per page path) so a Finder rename can be remapped after quit. |
| `.reader/session-<page>.json` | The same, for a session opened from a single file in this folder. |
| `.reader/map.json` | The session map's one-line page summaries and the fingerprint of the text each was written for. |
| `.reader/map.md` | The same map rendered, so it can be read without the app. |
| `.reader/versions/<page>/vN.md` | Snapshots taken before each refine. The live file is always the newest version. |
| `.reader/trash/<page>.md` | Pages deleted from the tree, with their snapshots beside them in `<page>-versions/`. Hidden folders are skipped when the folder is listed, so a trashed page stays out of the session until it is put back by hand. |

Settings are stored in the app config directory as `settings.json`, and the Home screen's list of recent sessions as `recents.json` beside it (folder, optional file, name, last opened, unread count, plus `folderId` / `fileId` Unix `dev:ino` and, on Mac, an `NSURL` bookmark for the folder). API keys are stored in the macOS Keychain under the service `app.nestedreader.nested`, the bundle identifier, one entry per provider. The app first shipped as `com.truefrontier.markdown-learner`; the first launch under the new identifier copies `settings.json`, `recents.json` and the keys across (`src-tauri/src/migrate.rs`) and leaves the old copies in place. The frontend never holds a key after saving it; Rust reads it when it makes a request.

## Home and sessions

Home replaces the window: recent sessions on the left, the ways to start one on the right. The ‹ beside the session title in the sidebar (⌘⇧H) steps up to it; the open session stays loaded, so leaving Home (Esc, or clicking that session) lands exactly where you were. Clicking another recent session loads that folder and restores its saved session.

A session is either a **folder** (every `.md` under it) or a **file**. Both come from the one Open panel behind ⌘O (`pick_path`, an NSOpenPanel in `src-tauri/src/open_panel.rs` that takes a folder or a `.md`, which the dialog plugin cannot do in one panel) or from a drop; `path_kind` decides which kind the path is. A file session lists only that page and the pages whose `source` chain leads back to it (`growsFrom` in `src/lib/tree.ts`); new pages are still written beside the file, so the folder stays the unit on disk and the session keeps its own `session-<page>.json`. Drops arrive through the webview's drag-drop events; `path_kind` tells the frontend whether a path is a folder, a Markdown file, or neither.

A session can take **more roots** (⌘⇧O, File › Add to Session…, the same panel with `purpose: "add"`, worded to allow choosing several folders and/or files at once — ⌘O stays single-selection): `session.roots` lists them as `{ folder, file? }`, so they travel with the session file. The pages of an added folder are keyed by their full path, `<folder>/<page>`, and their `source` links are given the same prefix on load (`keyedMeta` in the store), so they never collide with the session folder's relative paths and the tree links still resolve; a root that is the session folder itself keeps relative keys (a file session taking a sibling file). `loc(path)` in the store turns a key back into the folder and path inside it for every read, write and version call, so an added folder keeps its own `.reader/versions`; writes strip the prefix from `source` again, so the file on disk stays relative to its folder. Pages already in the session (compared by full path) are skipped, so overlapping roots never list a page twice. The sidebar hangs each added folder off the top as a header of its own (`buildFolders` takes the root folders; `FolderNode.root` marks them) with a ··· menu whose one item, Remove from session, drops every root in that folder and reloads. A root added as a single file (`r.file` set) gets that item on its own row's ··· menu too (`removeRootFile` in the store, keyed by `rootKey`), since such a root has no folder header when it was added from the session folder itself (a sibling of a file session).

With tools on, `AiRequest.roots` carries the added folders: `tools.rs` lists their pages by full path and reads and searches them alongside the session folder, and the Claude CLI gets one `--add-dir` per folder.

At launch, `openAtLaunch: "last-session"` reopens the first entry of `recents.json` (so a file session comes back as one), `"ask"` shows the folder picker, and `"nothing"` or a cancelled picker leaves you on Home.

### Files from Finder

`bundle.fileAssociations` in `tauri.conf.json` registers the built app for `.md` / `.markdown` under the content type `net.daringfireball.markdown`; Tauri's own extension table does not know `md`, so the type is named explicitly and declared in `src-tauri/Info.plist` (`UTImportedTypeDeclarations`, which Tauri merges in; that file must hold nothing Tauri also generates, since top-level keys replace). A double-click, Open With, or a drop on the Dock icon then reaches `lib.rs` as `RunEvent::Opened`. On a cold launch that fires before any window exists, so the paths wait in the `Opened` state until the main window's store calls `opened_paths`; from then on they go straight to it as an `"opened"` event (`emit_to("main")`, matched by a window-targeted listener, so page windows never see it). The store feeds either into the same `openPath` as ⌘O and drops, and a launch-time file wins over `openAtLaunch`. None of this applies to `tauri dev`: a bare executable has no bundle for macOS to register.

A rename in Finder is not watched live. Recents and session files keep the inode ids (and the Mac bookmark) so the same file can still be opened after quit: `openFolder` / `openRecent` call `resolve_session` before listing pages, which matches missing Markdown by `dev:ino` (the bookmark first, if the folder path itself is gone), remaps trail / current / unread / pending / `source`, and renames `.reader/session-*.json` and `versions/<page_key>/` when the destination is free. The same resolve runs on window focus, quietly, so a rename while Nested was in the background is picked up without a toast. Cross-volume copies get a new inode and are treated as a new file; there is no full-volume search if both the folder path and the bookmark fail.

`src-tauri/src/default_app.rs` reads which app opens Markdown (`NSWorkspace`, `URLForApplicationToOpenContentType`) and, on request, asks macOS to make it Nested (`setDefaultApplicationAtURL:toOpenContentType:`). macOS 26.4 and later confirm every such change with the user, so the command waits for the completion block and then reads the default back rather than assuming; the Settings window marks a dialog open meanwhile, since the system prompt takes focus and would otherwise count as a click outside. Settings › General › Markdown files shows the current app with a "Use Nested" action, and Home shows a one-line offer until Not now or until Nested is the app (`offerDefaultApp` in settings). Both are hidden under `tauri dev`, and the whole thing fails under App Sandbox, which the direct build does not use.

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
2. The current file is copied to `.reader/versions/<page>/vN.md`, then the file is overwritten. A stream that ended because the model hit its token ceiling is refused here (`done.truncated`, below): the answer stops mid-sentence, and writing it would replace a whole page with the part that arrived, so the page is left alone and the run's card carries the reason.
3. `session.json` records `pending[page] = N`, and keeps that number through later refinements: a page already awaiting review stays pinned to the snapshot its first refinement took. The review UI diffs version N against the live file at the word level, so refinements stacked on one page read as one set of edits; each changed span is tinted, hovering shows the old text with **Undo**. Undo rewrites the file; **Undo all** restores version N and deletes every snapshot from N on, so the stacked refinements leave no orphans; **Done** just clears the marks.
4. Later, the version pill lists snapshots. Viewing an old version shows its text with the spans that differ from today tinted amber; **Restore** writes it back and drops every newer snapshot, after a confirmation.

Diffing happens in TypeScript on the rendered text of each block (`src/lib/diff.ts`), so Rust never needs to understand Markdown.

## Analytics

Nested uses Aptabase for privacy-friendly desktop analytics (`analytics.rs`). All tracking becomes a no-op when `APTABASE_APP_KEY` is not set at compile time (or is empty), making development and local builds safe by default. Five events are tracked:

- **app_opened**: on app launch (includes app version)
- **feedback_sent**: after successful feedback submission (includes whether an email was provided: 0 or 1)
- **update_checked**: after an update check settles (includes result: `latest`, `available`, `unsupported`, or `error`)
- **update_installed**: after an update installs successfully (includes `from_version` and `to_version`)
- **ai_ask**: when an AI request starts streaming (includes `kind`: `quick_answer`, `new_page`, `deep_dive`, or `refine`)

No content, file paths, markdown, prompts, emails, API keys, model output, or user data is sent. The plugin is registered conditionally in `lib.rs` only when a key is present, and the ACL permission `freshjuice-tauri-aptabase:allow-track-event` is in `capabilities/default.json`. For release builds, the key is set in the GitHub Actions workflow as `APTABASE_APP_KEY` (from a secret of the same name).

## AI

`ai_stream` takes a provider, model, optional base URL, a system prompt and messages, and streams deltas back over a `tauri::ipc::Channel`. Providers:

- **OpenAI**: `POST {base}/chat/completions` with `stream: true`.
- **Anthropic**: `POST /v1/messages` with `stream: true`.
- **Ollama**: `POST {server}/api/chat` with `stream: true` and `think: false`, read as newline-delimited JSON; `GET {server}/api/tags` for the ping and the installed-model list (chat models only, local and smallest first). No key; the server URL is `ollamaUrl` in settings. The client has no overall timeout because local models can be slow.
- **Custom**: any OpenAI-compatible server; set the base URL in Settings.
- **Plans** (`auth: "subscription"` on the request, `cli.rs`): Anthropic runs `claude -p --output-format stream-json --include-partial-messages --setting-sources "" --strict-mcp-config` from a neutral folder and forwards `text_delta` events, with `--tools ""` and one turn when no folder is given and the read-only tools (below) when one is; OpenAI runs `codex exec --json` and forwards `agent_message` items. The pings are `claude auth status --json` and `codex login status`. The CLIs hold the sign-in; the app never handles a token.

The stream ends with `done`, which carries `truncated`: true when the turn stopped because the model reached its token limit — `stop_reason: "max_tokens"` on Anthropic, `finish_reason: "length"` on the OpenAI shape, `done_reason: "length"` on Ollama. The deltas that arrived are still sent, so the reader sees what the model managed, but the three callers each refuse to treat a cut-off answer as a finished one: a refine writes nothing, a new page keeps what arrived and shows why it stops short, and an answer card stays on show without being remembered against its highlight.

Every ping returns the provider's model list (`PingResult.models`). Settings shows it as a menu and, when nothing has been chosen for that provider and account mode, picks the cheapest tier it recognises (`src/lib/models.ts`: Luna, nano or mini for OpenAI; Haiku for Anthropic; the smallest local model for Ollama; the CLI aliases for plans). Under a Claude plan the list is fixed in `src-tauri/src/cli.rs` (`CLAUDE_MODELS`: `haiku`, `sonnet`, `opus`, `fable`), the aliases Claude Code resolves to the current model of each tier.
- **Built in** is present in the UI but not wired to a service in this build.

Prompts are built in `src/lib/prompts.ts`. What gets sent is controlled by the Context toggles in Settings: the highlight and its paragraph, the other pages in this session, or every page in the folder.

A prompt holds 60,000 characters: the current page up to 12,000, each session page up to 6,000, each folder page up to 3,000. Twelve session pages at that limit come to more than the whole budget, so 15,000 characters are held back for the folder tier — otherwise the session could take everything and the tier that is actually chosen for relevance would never be reached.

### The session map

The context block can only carry so many page bodies, and past that the model has no idea the rest of the folder exists — it cannot ask for a page it has never heard of. The session map (`src/lib/sessionmap.ts`, the Context toggle "Session map", on by default) is a page-by-page index that rides along in every prompt: every page named, the ones nearest the question described, and a line telling the model it can read any of the rest with the tools. It takes at most 6,000 characters — up to 60% of that describing the pages nearest the question, the rest naming as many of the others as will fit, with a count of any it could not — and sits ahead of the other pages' bodies, because knowing what exists is worth more than one more body.

Most of it costs nothing, being what the front matter already says: title, the `asks:` question the page was made to answer, the `from:` parent, when it changed and how many snapshots it has. Only the one-line `about:` is written by a model, one small call per page, and only for a page whose text has changed — `fingerprint()` (FNV-1a over the body) records the text each line was written for.

Those lines live in `.reader/map.json`, rendered beside it as `.reader/map.md` so the map can be read without the app (`load_map` / `save_map` in `files.rs`). A page being written streams in, so every flush would ask for a new line; `scheduleSummary` in the store pushes the job back instead, and only writes once the page has sat still for four seconds. The jobs run one at a time, because a corpus refine settles many pages at once and nobody is waiting on the map. A failure leaves the old line, or none.

Indexing goes in batches: `summaryMessages` takes several pages in one call, 1,500 characters of each and 24,000 per call, and asks for one numbered line per page. Pages are numbered rather than named because a number survives the round trip where a long path invites the model to tidy it. `parseSummaries` reads the lines back and leaves out anything that does not parse, so a page keeps no line rather than a wrong one. When the reply was cut off, the last line it parsed is dropped too: the sentence the model stopped in the middle of reads exactly like a finished one.

There is no bulk backfill of the folder a session was opened from: its pages gain their `about:` line the next time each is written or refined, so opening a big folder never runs up a bill nobody asked for. The rest of the map is there from the first prompt regardless.

Pages **added** to a session (⌘⇧O) are the exception, because nothing writes them and so nothing would ever index them — and they are the pages the reader knows least about. `offerToIndex` counts the ones with no current line and asks once for the lot (`confirm` in `lib.rs`, a native sheet, so it needs nothing of the reader UI and follows on from the Open panel), saying how many requests it will take and that the pages themselves are not changed. They are not: the lines go in the session folder's `.reader/map.json`, and an added root is only ever read. The work queues behind whatever the map is already doing and says what it managed when it is done. Roots restored when a session reopens are not offered again.

Folder pages are ranked against what the reader asked for — the question, the instruction or the brief, plus the highlight when there is one — and the ones sharing no word with it are left out. The scoring is BM25 in `src/lib/rank.ts`: term frequency saturates, rarer words count for more, a word in the title counts for what it is rare, and plurals fold onto their singulars so "ripple" finds a page about ripples. Pages are scored on the part that would actually be sent, so none can win on a passage past its own limit. Session pages keep their nearest-first order instead, because how the session was built says something no word count does.

### Tools

With `tools` on in settings (the default), every request carries `folder`, and the model may call three read-only tools defined in `src-tauri/src/tools.rs`: `list_pages` (path and title of every page), `read_page` (one page in full, clipped at 40k characters) and `search_pages` (case-insensitive line matches across the folder, at most 60, best pages first). They go through `files.rs`, so they cannot leave the folder, and they refuse hidden directories such as `.reader`. Without `folder` no tools are offered, and the system prompt gains a sentence about them only when they are (`tools()` in `prompts.ts`).

`search_pages` matches a line that contains the query as typed. The pages that matched are then ranked by the same BM25 as the prompt's context (`relevance` in `tools.rs`, sharing the stop words, the word split and the plural folding with `rank.ts` — the folder the model searches and the folder it is shown have to agree on what a word is). Lines come back a few per page before any page gets a second turn, so one chatty page cannot take all sixty. A query of several words that nobody wrote down verbatim would come back empty, which tells the model nothing, so it falls back to the separate words and says that is what it did.

Each API provider runs a loop of at most `MAX_ROUNDS` (8) turns in `ai.rs`: stream one turn, and if it ends in tool calls, run them and send the whole turn back with the results. Anthropic keeps every streamed content block (text, `tool_use`, thinking with its signature) and replays it as the assistant message, then a user message of `tool_result` blocks; an empty text block is dropped because the API rejects it. The OpenAI shape accumulates `delta.tool_calls` fragments by index and replays `tool_calls` plus `role: "tool"` messages; Ollama shares that shape, with arguments already as an object and `tool_name` on the result. Ollama, and the Custom provider, retry once without tools when the server rejects them ("does not support tools"), so a model without tool support answers plainly. Before each call the stream sends a `tool` event with a short line for the UI ("Reading replay.md", "Searching for “ripple”", "Listing the pages").

The plans get the CLI's own tools instead. Claude Code runs with `--tools Read,Grep,Glob --allowedTools Read,Grep,Glob --add-dir <folder> --max-turns 12` (print mode cannot ask for permission, so the read-only set is approved up front), still from the neutral folder; Codex runs with the session folder as its working directory under `--sandbox read-only`. Both get a line in their instructions naming the folder. Their `tool_use` blocks and `command_execution` items become the same `tool` events.

The store keeps `working[key]` per stream (`lookup:<id>`, `page:<path>`, `refine:<path>`) from those events, clearing it on the next text delta and at the end. Each answer card shows the line in place of its empty answer, a page being written shows it under its skeleton (`.tool-line`), and the refine card whose turn it is adds it under the instruction (`refineAtWork`).

`tsc` and the Playwright drive cover the browser build (the mock sends two tool events before its answer when `folder` is set). The tool loops are tested in `ai.rs` against a fake HTTP server on localhost for all three API shapes, and `tools.rs` has unit tests; both run with `cargo test` (on a Mac, or off a Mac against a stub `tauri` crate, since the real one needs the platform's webview libraries).

## Feedback

The **Send feedback** link at the foot of the sidebar (`.side-foot`) opens `FeedbackPopover`, the same bottom-of-pane box as ⌘N and ⌘R (`ui.panePopover = "feedback"`, so Esc and the other popovers treat it alike). It holds a note, an optional email, and one status line; ↵ makes a new line and ⌘↵ sends. The store's `sendFeedback` hands the note to the platform. In the browser the mock logs it (a note starting with `fail:` is refused, to see the error state). In the app, `send_feedback` in `lib.rs` builds the payload in `src-tauri/src/feedback.rs` (the trimmed note, the email when given, the app version, OS and architecture) and posts it as JSON to the relay URL compiled in from `NESTED_FEEDBACK_URL` in `src-tauri/.cargo/config.toml`; an empty URL makes the box say feedback is not set up in this build. A refusal from the relay is plain text and is shown as is; a timeout or a lost connection gets its own sentence. The note is capped at 5000 characters on both sides.

The relay (`feedback-relay/worker.js`, on Fly through `server.mjs`) is a dependency-free Cloudflare Worker holding a fine-grained GitHub token with Issues: write (and, for updates, Contents: read) on this repository. It files the note as an issue labelled `feedback`: the first line as the title, the note quoted in the body, a contact line with the email or "none given", and the app line. The repository is private, so the email is visible to collaborators only. `node --test` in that folder runs its tests against a stubbed `fetch`.

`.github/workflows/feedback-triage.yml` runs on a new issue carrying that label (or when the label is added by hand): Claude reads it, labels it bug, enhancement or question (and needs-info when it is too thin), looks for an earlier issue about the same thing, and leaves one comment saying where in the code it lands and a likely cause. `claude.yml` answers @claude mentions on issues and pull requests and `claude-code-review.yml` reviews each pull request with a sticky comment. All three need the Claude GitHub App installed and an `ANTHROPIC_API_KEY` repository secret.

## Updates

The app updates itself through Tauri's updater plugin. `src-tauri/src/updater.rs` wraps it in two commands: `check_for_update` asks the endpoint in `tauri.conf.json` (`plugins.updater.endpoints`) for the newest release and keeps what it finds in a `Pending` state, so `install_update` needs no second lookup; it downloads the signed `.app.tar.gz`, verifies it against `plugins.updater.pubkey`, swaps the bundle in, and reports progress down a channel (`{ type: "progress", downloaded, total }`, then `{ type: "installed" }`). `relaunch` restarts the app. A debug build (`tauri dev`) reports `supported: false`, since a bare executable has nothing to swap; the bar then never appears and the menu item says updates arrive in the built app.

On the frontend, `Platform.checkForUpdate`, `installUpdate` and `relaunch` map onto those commands; the mock pretends a release is out when the URL has `?update` (`?update=fail` makes the install fail part way) and reloads in place of the relaunch. The store keeps `update: { phase, current, version, notes, downloaded, total, message, dismissed }`. The main window checks four seconds after launch and every six hours; those checks are silent when nothing is newer or the server is unreachable. `check-update` from the menu (Nested › Check for Updates…) says "You're on the latest version" in the toast, shows the error in the bar when the check fails, and un-dismisses an update put off with Later. `UpdateBar` (`src/reader/UpdateBar.tsx`, `.update-bar`) sits at the foot of the window on Home and in a session: the offer with Update and relaunch / Later, the download with a percentage and a thin meter along the card's bottom edge, Installing, and the error with Try again. The Updates row in Settings › General talks to the platform directly, like the Markdown files row, since Settings is its own window: the running version with Check for updates, or the newer version with Update and relaunch.

Releases come from `pnpm release <version>` (`scripts/release.mjs`): from a clean `main` it writes the version into `package.json`, `tauri.conf.json`, `Cargo.toml` and `Cargo.lock`, commits, tags `v<version>` and pushes. `.github/workflows/release.yml` runs on the tag: it checks the tag against the config version, builds `--target universal-apple-darwin` with `tauri.release.conf.json` laid over the config (that overlay alone turns on `createUpdaterArtifacts`, so a local `pnpm tauri build` needs no key), and `tauri-action` publishes a GitHub Release with the `.dmg`, the `.app.tar.gz`, its `.sig` and `latest.json`. The updater key was generated with `tauri signer generate`; its private half is the `TAURI_SIGNING_PRIVATE_KEY` repository secret and its public half is in `tauri.conf.json`. Apple code signing and notarization are not set up; tauri-action picks them up from the `APPLE_*` variables named in the workflow's comment once a Developer ID exists.

The repository is private, so installed copies cannot fetch the release themselves. The relay (`feedback-relay/updates.js`) does it with its token: `GET /updates/latest.json` reads the newest release's `latest.json` asset and points each platform's `url` at `GET /updates/download/<asset id>/<name>`, which answers with a 302 to GitHub's short-lived signed link, so nothing streams through the relay; `GET /updates/dmg` sends a first install to the newest `.dmg`. The release lookup is remembered for a minute. The token therefore needs Contents: read as well as Issues: write. The endpoint in `tauri.conf.json` passes `version`, `target` and `arch` as query parameters; the relay ignores them and the updater compares versions itself, so an older manifest is simply "nothing newer".

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

## Work in parallel

Nothing waits its turn except work on the same page. `store.streams` holds one handle per stream key, and each key carries its own `CancelToken` and `Channel` on the Rust side, so a page being written, refinements on other pages and any number of quick asks all stream at once. Starting a page no longer stops an ask: the card it grew out of keeps streaming beside it.

Two things touching one page would race on `bodies[path]` and on the file, so each page holds a chain of its own: `queue(path, task)` in the store links the task behind whatever that page already has in hand and hands back its promise. `generatePage` and `refinePage` run through it, so a refinement asked for while a page is being written waits and then rewrites the finished body, while different pages keep running side by side. A corpus refine fans its pages out with `Promise.all` for the same reason: the pages are different, so their chains are too. A cancelled stream sends no last event, so `stopStream` also releases the task waiting on it (`releases`, keyed by stream key) — deleting a page mid-write would otherwise leave its chain stuck.

A selection refine that waited its turn cannot trust the block index its highlight recorded, because whatever ran ahead of it may have reshaped the body. So it looks the passage up again with `replaceFlexible` across the blocks, trying the recorded one first, and only gives up ("Could not find the selection in the page source.") when the text has genuinely gone.

## Refine and review state

A refinement snapshots the page (`.reader/versions/<page>/vN.md`), writes the new body and records `session.pending[path] = n` unless that page is already awaiting review, in which case the earlier number stands. `reviewBases` in the store holds, per path, the snapshot each pending page is reviewed against, so any pane showing that page (main or split) renders the tints and its own strip with Undo all and Done. Because the base stays pinned, two refinements on one page show one strip whose count spans both, and `undoAll` puts the pinned body back and drops every snapshot taken since. `done(path)`, `undoAll(path)` and `undoChange(change, path)` act on one page. A corpus refine therefore leaves every touched page pending until each is reviewed; the sidebar dot follows `session.pending`.

`ui.refines` holds one `RefineRun` per refinement asked for — `{ path, scope, text, error? }` under a run id — and each drives a status card of its own in the place of the refine box: in the page at its highlight for a selection, at the foot of the panes for page and corpus scope. Keyed per run rather than per page, so a page refine keeps its card, its scope and its instruction while a selection refine on the same page queues behind it, and two refinements stacked on one page read as the two pieces of work they are. Only the card whose turn it is carries the tool line: `refineAtWork` picks the oldest run on each page that has not failed, whatever its scope, since the chain runs them in the order they were asked for and a selection refine can hold the turn as readily as a page one. Both the pane-level cards and the in-page one read it, so a card queued behind another shows the instruction it is waiting to run and nothing about what the model is reading for somebody else. A corpus refine is one thing the reader asked for, so it takes a single run, naming the page it was asked from and covering the session.

A run that fails keeps its card, and its instruction, until it is answered: **Try again** retires the card and reopens the refine box on that instruction (`ui.refineRetry` seeds the pane box; the in-page box keeps the page's own draft), and Esc dismisses it. Clicking Try again always answers the card clicked, but ↵ needs an owner when several failed cards stand at once, or one press would retry them all and only the last instruction reopened would survive: `refineToRetry` gives the key to the newest failure, and every other card renders without it. The unwritten-page card stands down from ↵ while a failed refine holds it, so one press is always one retry. A card for a refinement still running is not dismissed by Esc, since the work carries on. A failed selection refine's card hangs off the highlight it was asked from, so a new highlight, or closing the box, takes it away. The cards and the pane-level boxes share one column (`.pane-stack`), so a second refinement can be typed while the first still runs. The ask and refine boxes share the typed draft, held by the page, across the ⌘R switch.

## Highlights in either pane

A highlight belongs to the pane it was dragged in: `ui.selection.pane` (and `pane` on each answer card) holds the pane role, and each `Page` draws the `.sel` wrap, the ask or refine box, the status card and the answer cards only for its own role. The verbs act on that pane's page, read through `panePath`: a New Page or Deep Dive asked from the split pane hangs off the split page and the `[[slug|text]]` link lands there, and a selection or page refine from the split rewrites the split page. The pane-level box (⌘R with nothing highlighted, ⌘N) still works on the main page. When the split pane's page changes (`openPage` beside or below) or the pane closes, `dropPaneUi` drops the highlight and the answer cards that sat there; navigating the main pane resets that pane's `ui` and leaves the split's cards and every page's refine status alone.

`ui.lookups` holds the answer cards on show, keyed `pane:block` (`lookupId`), one card per block per pane. Each streams under its own key, `lookup:<id>`, so a second question never cancels the first, and `Page` draws every card whose `pane` is its own at the block it belongs to. A follow-up typed into a card carries that card's id, so the answer lands back in it. Only one card is ever peeked at from hover (`withoutPeek` keeps that true); the streaming ones are many.

A Quick Answer is not lost when its card closes. Once the answer has streamed in (or a partial one is closed early), `rememberLookup` files it under the page in `session.asks`, keyed on the highlighted text and its block, so a follow-up replaces the earlier exchange instead of adding a second entry. The page draws each remembered ask as an `.asked` wrap, a dotted line under the text, re-finding the text with `flexiblePattern` when a refine has moved it and hiding the ask when the text is gone. Hovering the dotted text peeks at the card (`showAsk` with `peek`, which also sets the highlight); a card still streaming is never taken over. The peeked card closes shortly after the pointer leaves both the text and the card, and a click pins it so a follow-up can be typed. After Esc the text does not peek again until the pointer has left it once.

## Versions in either pane

`versions` and `versionBodies` in the store are keyed by page path, and `ui.versionView` holds one `{ history, viewing, confirmRestore }` per pane role (`main`, `split`). So each pane shows the version pill for its own page and can view, and restore from, an old version on its own; the same page can sit in both panes at two different versions. `toggleHistory`, `viewVersion`, `backToCurrent`, `askRestore`, `cancelRestore` and `restore` take the pane role and read the page from `session.current` or `session.split`. Esc closes the reading pane's history menu or version view first (the split when it is fullscreen, else the main pane), then the other's. A restore drops every newer snapshot, so a pane showing one of them on the same page returns to current too.

A version in the menu is a link like any other: ⌘Click and ⌘⇧Click pass the New Page and Deep Dive placement settings (via `placementFor`) to `viewVersion`. "beside" and "below" put the page in the other pane and view the version there (from the split's menu, the other pane is the main one). "window" opens a page window at that version: the window URL carries `&version=N`, which `init` hands to `openFolder` as `initialVersion`. "background" means nothing for a version, so it views the version in place like a plain click.

When both panes show the same page they scroll together: `useSyncScroll` (used by `App`) links the two `.pane` scroll containers in proportion, since the split renders the same text a little shorter. The split pane's tools show a link button, lit while `ui.syncScroll` is on; clicking it turns the link off and on. Opening a page beside or below turns it back on.

## Find and filter

`ui.find`, `ui.findQuery` and `ui.findIndex` describe the find bar; the page being read (the main pane, or the split when it is fullscreen) matches the query case-insensitively against each block's text, wraps the hits with `.fnd` (the current one `.fnd.cur`) through the same `applyWraps` path as selections and change tints, and scrolls the current hit into view. `findIndex` only counts steps; the page wraps it around the match count, so ⌘G keeps working across pages with different counts. ↵ in the box and every step also bump `ui.findSelect`; the page being read answers by measuring the current hit and calling `selectMatch`, which makes it the selection and opens the ask box (or the refine box, if that was open), so a question can follow a search without the mouse. ⌘F, ⌘G, ⌘⇧G and ⌘/ are handled in the webview (like ⌘R) so they work while a box has focus; the menu items carry the keys in their labels. `/` outside any box, or ⌘/, shows the tree and focuses its Filter box via `ui.filterFocus`.

## Clicks, marks and pages that failed to generate

A plain click on a link or tree row opens the page here. ⌘‑click uses the "⌘‑click opens" setting (`newPageOpens`, also where New Page ⌘↵ goes) and ⌘⇧‑click the "⌘⇧‑click opens" setting (`deepDiveOpens`, also where Deep Dive ⌘⇧↵ goes); ⌥ flips either (`placementFor` in the store). For a page that already exists, the "background" placement is a read‑later mark: it adds the page to `session.unread`, and doing it again removes it. Both settings sit under General.

The sidebar and map carry three marks: a solid blue dot for unread (`.udot`), a green ring for changes to review (`.cdot`, matching the strip's ring), and an amber dot for a page the model failed to write (`.fdot`). Each sidebar row also has a ⋯ button (shown on hover, or open the same menu with a right-click) holding four items. "Mark unread" / "Mark read" calls `toggleUnread`, the same flip the background placement makes. "Rename" swaps the row's label for a box (`RenameInput`, shared with the Home list): `renamePage` writes the new **title** to the front matter and to the page's first heading when that heading still reads as the old one, and leaves the file's name alone, so the `[[wiki links]]` and `source:` lines pointing at the page stay good. "Reveal in Finder" hands `loc(path)` to `reveal_in_finder`, so a page of an added root is found in its own folder. "Delete" calls `deletePage`: it stops any write still in flight for that page (a stream or a queued flush would put the file straight back), asks the backend to take the file out of the folder, and then clears the page from `pages`, `bodies`, the versions and review caches, and every list in `session.json` — the trail keeps its place, the split pane closes if it showed the page, and the reading pane falls back to where the trail now points or to the newest page left. Deleting the page a **file session** was opened from ends that session (back to Home, and out of recents); deleting the page an **added root** was opened from drops that root and reloads, which is what a reopen would have shown anyway. The menu, the rename box and the confirmation all close on a click elsewhere, Esc, or when the tree scrolls. The menu and confirmation are drawn in a layer above the tree (not inside the scrolling list) and flip above the row when there is no room below, so a row at the bottom of a long sidebar still shows them in full.

Delete is not a removal: `files::delete_page` moves the page and its snapshot folder into `.reader/trash/` inside the folder the page lives in, under one name (`<page>.md` and `<page>-versions/`, with `-2`, `-3` … if that name is taken), so a delete can still be undone in Finder. It asks first, from the row itself, and the confirmation's "Do not ask again" checkbox turns `settings.confirmDelete` off for good once that delete goes through; Settings › General › Deleting a page turns it back on. The confirmation is placed by `AnchoredLayer` from `.tree-inner`'s bounding rect (a body-level portal), so it reads the same at any depth and at any sidebar width.

## New page from the session (⌘N)

⌘N opens the same bottom box as a page or corpus refine (`ui.panePopover` is `"refine"` or `"new"`), from the File menu item or the key, which stays in the webview like ⌘R so it also works while the ask box has focus. The brief typed there is the page's `question`; `newFile` in the store calls `createPage` with `from: "session"` and no highlight, so nothing is linked in the source. The page's `source` is the page you were reading, which keeps it inside the session (and inside a file session). ↵ opens it here, ⌘↵ follows the New Page placement, ⌘⇧↵ writes a Deep Dive at its placement, ⌥ flips either.

`generatePage` then uses `newFileMessages` instead of `newPageMessages`: the current page plus the session and folder pages the Context toggles allow, and the brief as "New page: …". A retry tells the two apart by whether the source page holds a `[[slug|text]]` link to the page; a page with no link was started from the session.

Page generation is `generatePage` in the store, separate from creating the file. A failed stream leaves the page with its heading, records the message in `pageErrors`, and toasts if the page is not on screen. The page then shows a card with Try again (↵), and so does any page that holds only its heading. `retryPage` rebuilds the context from the source page by finding the `[[slug|text]]` link to the page, then streams again.
