# Progress

## Session: 2026-09-11 — scrolled text fades out under the window chrome

### Leading assumptions
- Kevin's screenshot shows the reader scrolled with the tree closed: article text ran straight under the traffic lights and the tree toggle, because the panes reach the top of the window and nothing sat between them and the chrome.
- The toggle's spot (right after the traffic lights, at the same spot whether the tree is open or closed) is the standard macOS placement (Finder, Notes, Mail), so it stays. The fix is a region the text does not enter, done as a fade rather than an opaque toolbar so the reader keeps its bare, edge-to-edge look.

### World facts
- `src/styles/app.css`: `.main::before` is a 64px strip across the top of the panes, solid `--bg` for 40px then fading to transparent, `pointer-events: none`, `z-index: 1`. The pane tools (z 2), the review strip (z 3) and the map (z 4) sit above it; the sidebar is outside `.main`, so its own background is untouched. Unscrolled pages start at 84px, so they never touch the fade.
- The Tauri `.titlebar` drag region keeps working: the strip ignores the pointer.
- `docs/architecture.md` has a paragraph on the strip after the sidebar-width paragraph.
- Verified in headless Chromium against `vite preview` at 900px, 560px and 1000px wide, tree open and closed, and with a split pane: the scrolled heading fades under the chrome, the toggle reads cleanly, the split pane's expand and close buttons stay above the fade. `tsc` and `pnpm build` pass.

### Timeline
1. Kevin sent a screenshot of text running under the tree toggle and asked for whichever is best: move the icon or add a region text does not enter.
2. Read the shell CSS (`.tl`, `.side-toggle`, `.titlebar`), the pane CSS and the overlay z-indexes.
3. Added the fade strip, built, screenshotted the browser build in Playwright, nudged the solid part from 36px to 40px, committed and pushed to `claude/kind-mccarthy-3i38qd`.

### Possible next steps
- Check the fade on a Mac in the Tauri build, in dark mode too: `--bg` is the app background, so it should match, but a tinted page background would show a seam.
- If the fade hides too much of a short page, the strip height and the solid stop are the two numbers in `.main::before`.

## Session: 2026-09-11 — Esc, ⌘W and click-outside close Settings

### Leading assumptions
- The browser build's embedded panel already closed on Esc and on a backdrop click; the gap was the native Tauri Settings window, where Esc did nothing, ⌘W was taken by File › Close Pane and sent to the reader, and clicking away left it open.
- For a separate native window, "clicking outside" means the window losing focus. So the window closes on blur, whether the click lands on the reader or on another app. The one exception is the folder picker opened from Change…, which also steals focus; a flag around that call keeps the window up until the picker is done.
- Esc inside a text box (the subfolder name, the number fields) keeps its old meaning of leaving the box; a second Esc closes the settings. Esc anywhere else closes at once.
- ⌘W in the Tauri app is a menu accelerator, so the webview never sees it; the Rust menu handler now closes the settings window when Close Pane fires with that window in front. The webview also handles ⌘W as a fallback (and for the browser build, where the browser may still close the tab).

### World facts
- `SettingsApp.tsx`: `close()` calls `onClose` when embedded, else `getCurrentWindow().close()`. A keydown listener handles Esc and ⌘/Ctrl‑W; `onFocusChanged` closes the Tauri window on blur unless `dialogOpen` is set. `General` takes `dialogOpen` and sets it around `platform.pickFolder()`.
- `lib.rs` menu handler: `close-pane` with the settings window focused closes that window instead of forwarding the command to the reader.
- `capabilities/default.json` gained `core:window:allow-close`, needed for the JS close call.
- Verified in headless Chromium against `vite preview`: ⌘, opens the panel; Esc, ⌘W and a backdrop click each close it; a click inside leaves it open; Esc in the subfolder box only leaves the box, then a second Esc closes. `tsc` and `pnpm build` pass. `cargo check` could not run here (no GTK dev libraries on the Linux box), so the nine-line Rust change is unverified by a compiler; it uses only `get_webview_window`, `is_focused` and `close`, all already in use in the file.
- `docs/architecture.md` has a paragraph on closing Settings, above "Running it".

### Timeline
1. Kevin asked that Esc, ⌘W, or a click outside close the settings "window".
2. Read `SettingsApp`, `App.tsx`'s modal, the Rust window and menu code, and the capabilities file.
3. Added the three close paths, the dialog guard, the Rust menu case and the capability; checked the browser build with Playwright.
4. Updated the docs, committed and pushed to `claude/determined-carson-c9ms82`.
5. Kevin asked to merge into main. Main had moved (⌘O rework, app renamed Nested, bundle identifier migration); merged it in, resolved the PROGRESS.md conflict by keeping both entries, re-ran tsc, build and the browser checks, then fast-forwarded main.

### Possible next steps
- Run `pnpm tauri dev` on a Mac to confirm the native window closes on blur, that Change… survives its picker, and that ⌘W reaches the Rust handler.
- If closing on ⌘Tab to another app feels wrong, limit the blur-close to focus moving to another window of this app (check `webview_windows()` on the Rust side).

## Session: 2026-09-11 — a change tint across two table cells made a fifth column

### Leading assumptions
- The broken table in Kevin's screenshot is the Milestones table of an analysis-tool README shown with review tints: the M2 row's last cell sat empty and its text showed in a fifth column, with "DONE 2026-09-11" and the cell text tinted.
- "First column not to wrap if it doesn't have to" is taken as a nowrap rule on the first column of every table. In auto table layout the browser squeezes every column in proportion, so a short label column wraps long before it needs to; nowrap makes the wider columns take the wrapping instead. A first cell that is genuinely longer than the reading column would overflow it, which is accepted because first columns are labels and IDs.

### World facts
- Cause, reproduced in headless Chromium with a probe page: `spansOf` in `src/lib/diff.ts` merges two changes separated by a gap of up to three punctuation or whitespace characters, and the newline between two `<td>`s is such a gap, so a status change and a description change in the same row became one change whose text ran across the cell boundary. `applyWraps` in `src/lib/wraps.ts` then wrapped the whitespace text node that sits between the cells, a direct child of `<tr>`; a `<span>` inside a table row renders as an anonymous extra cell.
- Fix: `applyWraps` skips text nodes whose parent is `table`, `thead`, `tbody`, `tfoot`, `tr`, `ul`, `ol` or `dl`. Only inter-row and inter-item whitespace lives there, and it still counts toward the `textContent` offsets, so nothing else moves. The one merged change keeps one `data-change` id across both cells, so hover and revert still treat it as one change. Applies to `.chg`, `.oldchg`, `.sel` and `.fnd` alike.
- New CSS in `src/styles/app.css`: `.article table` gets the same 22px bottom margin as every other block (it had none, so the next heading sat on the table), and `.article th:first-child, .article td:first-child { white-space: nowrap }`.
- Verified with the probe: before the fix the M2 row had 5 children and one `tr > span`; after, every row has 4 and no stray span, and the Milestone column renders on one line. `tsc` and `pnpm build` pass. The probe files were removed before committing.
- The branch `claude/funny-davinci-reuubs` was started from `main` at 9011d48 (the bundle-identifier commit).

### Timeline
1. Kevin sent a screenshot of the README's Milestones table with a fifth column and asked for the first column not to wrap.
2. Read the renderer, the diff, the wrap code and the article CSS; found no table CSS at all.
3. Reproduced the fifth column with a probe page under the dev server, fixed `applyWraps`, added the table CSS, re-ran the probe, then built and committed.
4. Kevin asked to commit and merge into main. Fast-forwarded `main` to the branch commit (7de5f1d) and pushed it.

### Possible next steps
- Tables wider than the reading column overflow it; a horizontal scroll container around `.article table` would keep them inside the pane.
- Dates such as `2026-09-04` break at their hyphens when a column is squeezed; `white-space: nowrap` on cells that hold only a status and a date, or `word-break: keep-all`, would stop that.
- Header cells inherit the browser's centered alignment; left-aligning `th` would line them up with their columns.

## Session: 2026-09-11 — the bundle identifier follows nestedreader.app

### Leading assumptions
- "Bundle id should follow the domain name" means Apple's reverse-DNS convention: `nestedreader.app` reversed is `app.nestedreader`, plus a product segment, so `app.nestedreader.nested`. No platform segment, because universal purchase on the App Store needs one bundle ID across Mac and iOS.
- The Keychain service string follows the identifier, so the two do not drift. The crate, lib, package and binary names follow the product name: `nested`, `nested_lib`, `target/debug/nested`.
- "Migrate" means the first launch under the new identifier carries over what the old one held: `settings.json`, `recents.json` and each provider's API key. The old copies stay as a backup; nothing is deleted.

### World facts
- `src-tauri/src/migrate.rs` runs first in the setup hook, only while the new config folder does not exist. It creates that folder (closing the gate, so a key deleted later is not brought back on the next launch), copies the two files from `<config parent>/com.truefrontier.markdown-learner`, and copies the `openai`, `anthropic` and `custom` Keychain passwords from the old service to the new one. Failures are printed, never fatal.
- The identifier lives in `tauri.conf.json`; the Keychain service is `ai::KEYCHAIN_SERVICE`. The Caches and WebKit folders under the old identifier are disposable and were left alone.
- Everything else that carried the old name: `Cargo.toml`, `main.rs`, `package.json`, the CLI scratch folder in `cli.rs`, and `docs/architecture.md`.

### Timeline
1. Kevin asked whether the bundle id should follow the domain; answered with the reverse-DNS convention and what changing it moves.
2. Kevin chose `app.nestedreader.nested` with a migration. Wrote the migration, changed the identifier, the Keychain service and the crate names.
3. Verified the migration on this Mac, then committed on `main` after a fetch and pushed.

### Verification
- `tsc` and `pnpm build` pass; the Rust side compiles as `nested` with no warnings.
- Planted a throwaway item under the old Keychain service before the rebuild. On relaunch the new config folder appeared with `settings.json` byte-identical to the old and `recents.json` copied (the app then updated its last-opened stamp), and the throwaway item was present under the new service with the same value. Both throwaway items were deleted afterwards.
- The process is `target/debug/nested`; the menu bar reads Nested, About Nested, and the window title is Nested.

### Possible next steps
- Once every Mac that ran the old identifier has launched the new build, `migrate.rs` and the old-identifier constant can go.
- The old `~/Library/Application Support/com.truefrontier.markdown-learner`, Caches and WebKit folders can be removed by hand when nobody needs the backup.

## Session: 2026-09-11 — ⌘O opens a folder or a file, and the app is called Nested

### Leading assumptions
- "⌘O should be the only open shortcut and it should open folders and/or files" means one Open… item on ⌘O, and one panel where a folder and a `.md` are both selectable. ⌘⇧O and Open File… go away rather than pointing at the same panel.
- The panel is a standalone window (`runModal`), the macOS convention for Open… in TextEdit and Xcode. The dialog plugin's panel was a sheet on the main window.
- Settings › General › Folder is a default folder, not an open shortcut, so it keeps a folder-only picker. "Ask" at launch uses the new panel.
- "App name should be Nested" means every name a user sees. The bundle identifier `com.truefrontier.markdown-learner` and the crate and package names stay: the identifier names the Keychain service and the settings folder, so renaming it would orphan saved API keys, `settings.json` and `recents.json` unless migrated.

### World facts
- `pick_path` in `src-tauri/src/lib.rs` runs `open_panel::folder_or_markdown()` (`src-tauri/src/open_panel.rs`) on the main thread: an NSOpenPanel with files and directories both choosable, `.md`/`.markdown` filtered, and a message line. Non-macOS builds fall back to `pick_folder`. `objc2`, `objc2-app-kit` and `objc2-foundation` are direct macOS dependencies now, with the feature lists `rfd` already enables, so nothing new compiles.
- `Platform.pickPath` replaces `pickFile`; `pickFolder` stays for Settings. The store's `openPath(path, otherwise)` dispatches by `pathKind` and is shared by ⌘O, drops and the launch-time "ask". The menu id is `"open"`; the browser build's ⌘O branch ignores ⌘⇧O.
- Home shows one card, "Open a folder or file… ⌘O"; `.home-cards` is a single column.
- Visible name: `productName`, both window titles, the app menu, About, `index.html`, README and `docs/architecture.md`.
- A `src-tauri/target` copied from another checkout fails `tauri dev` with `failed to read plugin permissions` pointing at the old path. `cargo clean -p` on the packages whose `target/debug/build/*/output` holds the old path fixes it in one rebuild.

### Timeline
1. Pulled `main` (already up to date), fixed the stale build cache, ran `pnpm tauri dev`.
2. Kevin asked for ⌘O as the only open shortcut, taking folders and files. Replaced the two dialog-plugin commands with the NSOpenPanel command, rewired the store, key handler, Home and docs.
3. Kevin asked to pull before committing; `main` had gained pull request #5 (folders in the sidebar). Pulled under the working changes with no conflicts.
4. Kevin asked for the app to be called Nested. Renamed every visible name.
5. Committed on `feature/open-panel-and-nested-name`, then fast-forwarded `main` to it and pushed at Kevin's request.

### Verification
- `tsc` and `pnpm build` pass; the Rust side rebuilds with no warnings.
- In the dev app, checked through System Events: the File menu is New Page…, Open…, Close Pane; Open… carries ⌘O with no other modifier; choosing it opens a panel whose message reads "Open a folder of Markdown notes, or a single .md file.", with folders selectable and `.md` files enabled beside them; Escape closes it. The menu bar reads Nested, About Nested, and the window title is Nested.
- In the browser mock: Home shows the one card; ⌘O opens the sample folder; ⌘⇧O does nothing.

### Possible next steps
- Decide whether the bundle identifier, crate and package names follow the rename; that needs a one-time move of the Keychain entries and the config folder.
- `design/Research Reader.dc.html` and `design/Research Reader Wireframes.dc.html` still show Open file… beside Open folder….
- The browser mock's ⌘O always opens the sample folder, so file sessions can only be tried in the app now.

## Session: 2026-09-11 — folders in the sidebar, and a draggable sidebar width

### Leading assumptions
- "Folders" means the directories on disk under the session folder. The sidebar keeps its session tree (pages hung under their sources) but now inside each directory, so the folders are the outer structure and the source tree the inner one. A page whose source is in another directory is a root of its own directory.
- Subfolders come before pages in each directory, by name (numeric-aware, case-insensitive), as in most file trees. Only directories holding pages are shown, because the page list is the only thing the backend reports.
- Closed folders belong to the session (`session.collapsed`), like `session.sidebar`, so they come back on reopen. The sidebar width is an app-wide setting (`settings.sidebarWidth`), like text size, because a width is a taste rather than a fact about one session.
- While filtering or in Unread only, every folder is open and empty ones are left out; a folder the user closed stays closed once the filter is cleared.
- The width is dragged only; there is no Appearance row for it. Double-click on the edge resets to 224px.

### World facts
- `buildFolders`, `dirOf` and `folderChain` in `src/lib/tree.ts`. `FolderNode = { path, name, folders, items }`, `items` being `buildTree` over that directory's pages.
- `Session.collapsed?: string[]`; `store.toggleFolder(dir)` and `store.revealInTree(path)`. The Sidebar calls `revealInTree` whenever `session.current` changes, so a page opened from a link inside a closed folder makes its folder open.
- The filter now matches title or path, so a folder name finds its pages.
- `Settings.sidebarWidth` (default 224, clamped 180–480 by `sidebarWidthPx`), applied by `applyTheme` as `--side-width`; `.side` takes `width: var(--side-width)`. `store.previewSidebarWidth` sets the variable live during a drag; `store.setSidebarWidth` saves once on pointer up. No Rust change: settings and sessions are stored as untyped JSON.
- New CSS: `.rows` (a directory's page block with its own `.tree-line`), `.folder`, `.frow` (chevron rotates when `.folder.open`), `.fbody` (15px indent per level), `.side-grip` (7px strip on the sidebar's right edge, accent line on hover).
- The Web and Timeline maps still use `buildTree` and are unchanged.
- Verified in headless Chromium with a temporary sample that had `notes/`, `notes/deeper/` and `archive/`: nesting and ordering right; closing `deeper` then `notes` hides their rows; filter "ripple" opens folders and drops `archive`; filter "deeper" matches by path; clearing the filter brings back the remembered closed state; opening Ripple count reopens `notes` and `deeper`. Drag: +60 previews without saving, +120 saves 344, +900 clamps to 480, −900 clamps to 180, the width survives a reload, double-click restores 224. `tsc` and `pnpm build` pass. The sample fixtures were removed before committing.

### Timeline
1. Kevin asked for folders in the sidebar so a big session is not one long list, then added that the sidebar width should be draggable.
2. Read Sidebar, tree.ts, the store, the Rust page walker (already recursive, paths relative with `/`) and the settings plumbing.
3. Added the folder tree, the session field, the store methods, the sidebar rendering and CSS; then the width setting, grip and store methods.
4. Checked both in the browser build, updated `docs/architecture.md`, committed and pushed to `claude/sweet-einstein-q75jqd`.

### Possible next steps
- Show folder headers in the Timeline map too, if the long list is a problem there as well.
- A right-click or ⌥-click on a folder chevron to close or open every folder at once.
- Let ⌘N or New Page pick a target folder; today new pages go beside their source (or into `newPagesSubfolder`).

## Session: 2026-09-11 — page width in Appearance

### Leading assumptions
- "Reading page width % or ems" means the width of the reading column (`.article`), which was fixed at 560px (520px in the split pane). One setting with a unit switch covers both: `em` measures in ems of the reading text, `%` as a share of the pane.
- em is the default, at 33em: that is the old 560px at the default 17px text, and the split pane's 1px-smaller text lands it at 528px, next to the old 520px. Nothing moves on upgrade, and the column follows the Text size slider.
- The setting keeps a value per unit, so flipping between em and % brings back the last choice made in each rather than converting (the settings window cannot know the pane's width).
- Ranges are 20–60em and 30–100%. A hand-edited settings file outside those is clamped when applied.

### World facts
- `Settings.readingWidth: { unit: "em" | "percent"; em: number; percent: number }` in `src/platform/types.ts`, with `READING_WIDTH_RANGE` and `readingWidthCss`. The Tauri bridge merges the nested object like `auth`, `models` and `context`. No Rust change: `save_settings` stores an untyped `Value`.
- `applyTheme` in the store writes `--reading-width` beside `--text-size`; `.article` reads it as `max-width`, and the split pane's own `max-width` is gone so it inherits. em resolves against the article's font, so the split column comes out a little narrower than the main one, as before.
- Settings › Appearance gained a "Page width" row: slider, number box, em / % switch and a hint line. The number box applies in-range values as you type and clamps on ↵ or blur.
- Popovers place themselves relative to their block, so a wider or narrower column does not move the caret math.
- Verified in the browser build (mock backend): default 561px main; 50em → 850px; % → 70% of the pane (683 of 976) and 100% fills it; typing 999 waits for blur then clamps to 100; typing 45 applies live; back to em restores 50em; the split pane is 528px at 33em and 45% of its pane in % mode; the choice survives a reload. `tsc` and `pnpm build` pass.

### Timeline
1. Pulled `main`; it was already up to date after pull request #3.
2. Added the setting, the CSS variable, the store hook-up and the Appearance row.
3. Verified in the browser preview and added an Appearance section to `docs/architecture.md`.
4. Committed on `feature/appearance-page-width` and opened [pull request #4](https://github.com/truefrontier/nested-reader/pull/4), then merged it into `main` at Kevin's request.

### Possible next steps
- Add the row to `design/Reader Settings.dc.html`, which still shows only Theme, Text size and Reading font.
- Try it in `pnpm tauri dev`, where Settings is its own window and the change reaches the reader over `settings-changed`.
- Offer a couple of presets (narrow, wide) if the slider gets nudged often while reading.

## Session: 2026-09-11 — ⌘Click on a version follows the placement settings

### Leading assumptions
- "According to settings" means the same rule wiki links and the crumb use: ⌘ is the New Page placement, ⌘⇧ the Deep Dive placement, ⌥ flips either. The store's `placementFor` already encodes it.
- "beside" and "below" mean the other pane. From the main pane's menu the version opens in the split pane. From the split pane's menu it opens in the main pane, navigating there first if the main pane shows another page.
- "window" opens a page window that starts out viewing that version.
- "background" has no meaning for a version (there is nothing to read later), so it views the version in place, like a plain click. With default settings ⌘⇧Click therefore behaves like a plain click.
- After any placement, both panes' history menus close.

### World facts
- Repo: truefrontier/markdown-learner, branch `claude/festive-mayer-evnlm3`. The earlier work on this branch merged as [pull request #1](https://github.com/truefrontier/markdown-learner/pull/1); the branch was restarted from `main`, so this is a fresh change.
- `viewVersion(n, role, placement = "active")` in `src/state/store.ts` handles the placements. `TopStrip` passes `store.placementFor(e)` from the item's click.
- `openPageWindow(folder, path, version?)` gained an optional version. The mock appends `&version=N` to the URL; the Tauri command `open_page_window` takes `version: Option<u32>` and does the same. `init` reads the `version` URL parameter and `openFolder` views it after navigating to `initialPage`.
- `cargo check` still cannot run here (no GTK dev libraries), so the Rust change is unverified by a compiler. It is a four-line addition: an `Option<u32>` argument and a `push_str` on the URL.
- Verified in headless Chromium against the Vite dev server: ⌘Click in the main menu opens the page beside, viewing Version 1 there, with the main pane on current, both menus closed, and sync scroll lit. Plain click in the split menu views in the split. ⌘Click in the split menu, with the main pane on another page, navigates the main pane to the page and views the version there. ⌘⇧Click with the default "background" setting views in place. The window placement opens `?page=…&version=1`, and opening a folder with `initialVersion` starts on Viewing Version 1. Typecheck passes.

### Timeline
1. Kevin asked that ⌘Click on a version in the dropdown open it according to settings.
2. Added the placement parameter to `viewVersion`, the version parameter to `openPageWindow` in the mock, Tauri bridge, and Rust command, and the URL parameter handling in `init` and `openFolder`.
3. Ran the browser check; all cases passed. Updated `docs/architecture.md`.
4. Committed and pushed.

### Possible next steps
- Run `pnpm tauri dev` locally to compile the Rust change and try the window placement in the real app.
- Decide whether ⌥ should flip a version click at all; today it follows `placementFor`, so ⌥⌘Click yields "background", which views in place.

## Session: 2026-09-11 — versions in the split pane, and synced scrolling

### Leading assumptions
- "The same file open in two panes" means `session.current === session.split`. The app already allowed this; nothing stopped a page from being opened beside itself.
- Synced scrolling is proportional, not pixel for pixel. The split pane renders the same text a little narrower and smaller, so equal scroll fractions keep the same passage in view on both sides. When one pane shows an old version, proportional is still the sensible match.
- The sync button appears only when both panes show the same page. It starts lit (sync on); clicking it turns sync off and dims it; clicking again turns it back on. Opening a page beside or below resets sync to on.
- Each pane owns its own version view, so one pane can show Version 1 while the other shows current. The pill and menu also now show in the split pane.
- Esc closes the reading pane's history menu or version view first (split when fullscreen, else main), then the other pane's.

### World facts
- Repo: truefrontier/markdown-learner, branch `claude/festive-mayer-evnlm3`, [pull request #1](https://github.com/truefrontier/markdown-learner/pull/1) into `main`. The repo has no CI workflow, so the PR shows no checks.
- Before this change, `versions` and `versionBodies` were single slots refreshed only for the main pane's page, and `TopStrip` hid version history unless `role === "main"`. That is why the dropdown never showed in the split pane.
- Now `versions: Record<path, VersionInfo[]>`, `versionBodies: Record<path, Record<n, string>>`, and `ui.versionView: Record<"main" | "split", { history, viewing?, confirmRestore }>`. The old `ui.history`, `ui.viewing`, `ui.confirmRestore` are gone.
- `refreshVersions(path)` now runs for the split page too: on open beside/below, on session load, after a refine writes a page shown in either pane, after Undo all, and after Restore.
- Restore from one pane drops newer snapshots, so the other pane goes back to current if it was viewing a dropped version of the same page.
- The panes' scroll containers are the `.pane` divs directly under `.main`. `useSyncScroll` in `src/reader/useSyncScroll.ts` links them; `App.tsx` calls it with a ref to `.main`. An `echo` guard drops the scroll event the code itself causes, so the panes do not feed each other.
- New `SyncScrollIcon` in `Icons.tsx`; `.tbtn.on` in `app.css` colors the lit button with `--acc`.
- Verified in headless Chromium with Playwright against the Vite dev server: split pane shows the pill and menu; picking a version shows "Viewing Version 1" only in the split with amber tints only there; both panes can view versions at once; Esc closes main's then split's; Restore confirm shows only in the pane that asked; scroll fractions match within 0.001 in both directions; with sync off, main scrolls and split stays put; turning sync back on re-aligns the split. `tsc --noEmit` passes.

### Timeline
1. Read SplitPane, Page, TopStrip, the store's version code, and the pane CSS.
2. Re-keyed versions by path and added a per-pane version view to the store; updated every caller.
3. TopStrip and Page read the pane's own view and the page's own versions.
4. Added the sync scroll hook, the icon, the button in the split pane's tools, and the `.tbtn.on` style.
5. Ran the browser check, fixed nothing (it passed), took screenshots, updated `docs/architecture.md`.
6. Committed and pushed.
7. Kevin opened [pull request #1](https://github.com/truefrontier/markdown-learner/pull/1) from the Claude Code UI. The session is subscribed to its activity. At open it was mergeable with no CI checks and no comments.
8. Kevin merged the pull request into `main` about two minutes later, with no review comments. The session unsubscribed from it and cancelled its check-in. The branch was restarted from `main` for this note, so any later work on it is a fresh change.

### Possible next steps
- Consider aligning by block index instead of by fraction when both panes show the same version, for a tighter match on very long pages.
- Decide whether the sync button should also appear when the two panes show a page and one of its versions in fullscreen (hidden main pane means no scrolling to sync, so it is left as is).
- Persist `syncScroll` in the session file if the choice should survive a restart.

## Session: 2026-09-11 — ⌘B toggles the sidebar

### Leading assumptions
- ⌘B replaces ⌘\ as the sidebar shortcut. It does not sit alongside it. One shortcut per action keeps the menu, the button tooltip, and the web fallback in agreement.
- Nothing in the app used ⌘B before this change. A grep of src, src-tauri, docs, and design found no other binding.

### World facts
- Sidebar toggle flows through `store.command("toggle-sidebar")`, which calls `store.toggleSidebar()`.
- In the Tauri build, menu accelerators own the shortcuts. The web keydown handler in `src/App.tsx` skips those keys when `isTauri` is true.
- In the plain web build, the keydown handler in `src/App.tsx` handles shortcuts itself.
- The Tauri menu lives in `src-tauri/src/lib.rs`, in `build_menu`.
- Frontend typechecks and builds with pnpm. `cargo check` cannot run in this container because GTK dev libraries are missing.

### Timeline
1. User asked: ⌘B should toggle the sidebar.
2. Found the sidebar bound to ⌘\ in four places: the Tauri menu accelerator, the web keydown handler, the toolbar button tooltip, and the design mockup tooltip.
3. Changed all four to ⌘B.
4. Ran `tsc --noEmit` and `pnpm build`. Both passed.
5. Committed and pushed to `claude/compassionate-wozniak-1mthzr`.

### Possible next steps
- Run the Tauri app locally to confirm the View menu shows ⌘B and the shortcut fires.
- Decide whether ⌘\ should stay as a second binding in the web build for anyone used to it.

## Session: 2026-09-11 — split-pane back link closes the child page

### Leading assumptions
- "Back link at the top of a page" is the `.crumb` element in `src/reader/Page.tsx`, which links a generated page to its `meta.source` parent.
- "Already shown" means the parent is the main pane's current page. The check is `session.current === meta.source` and applies only when the page renders in the split pane.
- Closing the split pane is the right way to refocus on the parent. It also drops fullscreen, since `closeSplit` already does that.

### World facts
- Repo: truefrontier/markdown-learner, branch `claude/ecstatic-sagan-n78yyw`.
- Vite + React + Tauri app. Reader state lives in `src/state/store.ts`. The split pane is `src/reader/SplitPane.tsx`, and both panes render `src/reader/Page.tsx` with a `role` of "main" or "split".
- Before this change, the crumb always called `store.navigate(source)`, which re-navigated the main pane to the page it already showed and pushed a duplicate trail entry.
- `npx tsc --noEmit` passes after the change. No test suite exists in the repo.

### Timeline
1. Read the crumb handler, store navigation, and split pane code.
2. Changed `onCrumb` in `Page.tsx`: in the split pane, when the parent is the main pane's current page, call `store.closeSplit()` instead of navigating.
3. Type check passed. Committed and pushed to the feature branch.
4. Follow-up request: the crumb should respect the ⌘Click and ⌘⇧Click settings. `onCrumb` now reads `store.placementFor(e)`, the same helper wiki links, the sidebar, and the map use. A non-active placement calls `store.openPage(source, placement)`. A plain click keeps the close-or-navigate behavior from step 2. Type check passed again. Committed and pushed.

- ⌥ flips the placement, as it does for wiki links, because `placementFor` handles it.

### Possible next steps
- Decide whether the same rule should apply in reverse: the main pane's crumb when the parent is open in the split pane. Left unchanged, since the request was about the split panel.
- Consider the case where the parent is not current but is elsewhere in the trail. Left as a plain navigate.

## Session: fade the loading skeleton before streamed text (2026-09-11)

### Leading assumptions
- "Loading animation" means the skeleton bars a new page shows while the model writes it (`src/reader/Page.tsx`, `.skeleton` in `src/styles/app.css`).
- The bars had no motion of their own, so they now pulse gently; the pulse is off under `prefers-reduced-motion`.
- A page opened after streaming has already started shows its text straight away, with no skeleton and no fade.
- The skeleton that shows while a page file is still being read (body undefined) is a different wait and is unchanged.

### World facts
- Page generation streams through `generatePage` in `src/state/store.ts`; the page body starts as a heading-only stub and grows with each delta.
- The browser build uses the mock platform, which streams a fake answer after about 350 ms. It needs a model chosen in settings (`ml:settings` in localStorage), or it errors with "Choose a model".
- New Page opens beside the current page by default, in a split pane.
- Deciding the fade in an effect unmounted the skeleton for one frame, so the CSS transition never ran. Deriving the fade during render keeps the element mounted and the transition works.

### Timeline
1. Read the page, store, and CSS to find where the skeleton and streaming live.
2. Changed `Page.tsx`: the skeleton shows only while the page is heading-only; on the first streamed text it fades over 260 ms while the page keeps showing just the heading; then the streamed body appears and the skeleton is gone for the rest of the stream.
3. Changed `app.css`: skeleton opacity transition, `.fading` state, gentle pulse on the bars, reduced-motion opt-out.
4. Verified in headless Chromium with Playwright: per-frame opacity goes 1 to 0 over ~260 ms with only the heading visible, and text blocks appear only after the skeleton is removed.
5. Typecheck passes. Committed and pushed to `claude/vibrant-sagan-54yeny`.

### Possible next steps
- Add a streaming caret to the last block while text streams (the `.block.streaming` class exists but has no styling).
- Apply the same fade to the file-read skeleton if that wait ever feels abrupt.

## Session 2026-09-11 — in-page find and filter focus

### Facts about the app
- Tauri 2 + React reader for a folder of Markdown notes. `pnpm dev` runs it in a browser with an in-memory sample folder; `pnpm tauri dev` runs the real app.
- Keyboard shortcuts live in two places: native menu accelerators in `src-tauri/src/lib.rs` (⌘K, ⌘\, ⌘[ and so on) and a `keydown` listener in `src/App.tsx`. ⌘R was moved into the webview earlier so it works while typing in a box; ⌘F, ⌘G, ⌘⇧G and ⌘/ follow the same pattern, and their menu items carry the keys in their labels.
- Page text is wrapped in spans by `applyWraps` (`src/lib/wraps.ts`) using offsets over each block's `textContent`. Selections, change tints and now find highlights all go through it.
- The ask and refine boxes focus themselves 60 ms after mounting (`useAutoFocus` in `src/reader/Popovers.tsx`).

### What was built
- Find bar (`src/reader/FindBar.tsx`) stacked under the review strip at the top of the pane being read. Case-insensitive substring matching, "n of m" count, ‹ › arrows, close.
- ⌘F opens it (a fresh selection becomes the query). ⌘G / ⌘⇧G step. ↵ in the box selects the current match. Every step also selects, which opens the ask box on the match with its input focused; ⌘R switches to refine and that mode survives further steps.
- `/` outside any box, or ⌘/, shows the tree if hidden and focuses its Filter box. Esc there clears the filter, then leaves the box.
- Esc inside an ask, refine or follow-up box now closes only that box (it used to also close whatever was behind it).
- README shortcut table and `docs/architecture.md` updated.

### Assumptions
- Find targets the main pane, or the split pane only when it is fullscreen; the split pane is not searched otherwise.
- Match selection only happens in the main pane and never while viewing an old version, because selection popovers only exist there.
- Menu items without accelerators are the right call for shortcuts that must work while typing, matching the ⌘R precedent.

### Verification
- `tsc` and `pnpm build` pass. Two Playwright scripts against `pnpm dev` covered every shortcut, wrap-around, no-match state, popover placement and focus.
- `cargo check` could not run on this Linux box (no GTK dev libraries), so the Rust menu change is checked by reading only.

### Possible next steps
- Try it in the real Tauri build on macOS to confirm ⌘F, ⌘G and ⌘/ reach the webview with the native menu in place.
- Carry the typed question across ⌘G steps instead of resetting it with each new selection, if that turns out to be wanted.
- Enter in the Filter box could open the first visible page.

## Session: 2026-09-11 — ⌘N: a new page written from the whole session

### Leading assumptions
- "Like Refining with full session context, but it's a new file" means: ⌘N opens the same bottom box as a page or corpus refine, takes a brief instead of a highlight, and writes a brand-new `.md` using the current page plus the session pages as context.
- The new page hangs off the page you were reading (`source`), so it stays inside the session and inside a file session. Nothing is linked in the source, since there is no highlight.
- The Context toggles in Settings still decide what leaves the machine. ⌘N does not override them; with "Other pages in this session" on (the default) the whole session goes with the request.
- ⌘N verbs follow the ask popover's grammar: ↵ opens the page here, ⌘↵ uses the New Page placement, ⌘⇧↵ writes a longer Deep Dive at its placement, ⌥ flips either.
- This task supersedes `claude/upbeat-davinci-pezf5c`, which added a "New session" (⌘O) button to the foot of the session sidebar. That button is not carried over; a "New page ⌘N" button sits in that spot instead.

### World facts
- App: Tauri 2 + React + Vite. Reader state lives in `src/state/store.ts`, popovers in `src/reader/Popovers.tsx`, prompts in `src/lib/prompts.ts`, the native menu in `src-tauri/src/lib.rs`.
- The ⌘R key is handled in the webview, not as a menu accelerator, so it also works inside the ask box. ⌘N follows the same pattern: File › "New Page… (⌘N)" has no accelerator.
- `ui.panePopover` was a boolean; it is now `"refine" | "new" | undefined`.
- `createPage` and `generatePage` take `from: "session"` to pick `newFileMessages` over `newPageMessages`. A retry tells the two apart by whether the source page holds a `[[slug|text]]` link to the page.
- The mock backend (`pnpm dev`) recognises the new prompt ("adding a new page") and the "New page:" line so browser previews stream sample text.
- The Rust side cannot be compiled in this container (missing GTK dev libraries); the Rust change is two menu-builder lines.

### Timeline
1. 2026-09-11: User asked for ⌘N to work like Refining with full session context, but producing a new file. Mid-task the user said this task supersedes `claude/upbeat-davinci-pezf5c`.
2. Read the store, popovers, prompts, menu, and docs. Chose to reuse the bottom pane box and the New Page / Deep Dive placements.
3. Added `newFileMessages`, `newFile`, `toggleNewFile`, the `"new-page"` command, `NewFilePopover`, the ⌘N key handler, the File menu item, and the sidebar button.
4. Verified in the browser with Playwright: the box opens and closes on ⌘N, ↵ writes a page here with three paragraphs, ⌘⇧↵ hangs a Deep Dive branch under the current page, a failed page retries through the session route, ⌘N from inside the ask box swaps to the new box, Esc closes it.
5. Type check and production build pass. Updated README and `docs/architecture.md`.

### Possible next steps
- Let ⌘N inside the refine box swap to the new-page box and back, the way ⌘R swaps ask and refine.
- Show a status card for a ⌘N page sent to the background, since the only signal today is the tree's loading dot and a toast on failure.
- Consider recording the origin in front matter (rather than inferring it from the missing link) if other origins appear later.

## Session: 2026-09-11 — highlights in the split pane, nested tree, quoted titles

### Leading assumptions
- "Highlighting in a nest page doesn't show the popover" means a child page: New Page ⌘↵ opens it beside by default, and the split pane ignored highlights on purpose (an earlier session's "main pane only" rule). The fix makes a highlight belong to the pane it was dragged in rather than moving the page to the main pane.
- "Nested pages aren't nested in the sidebar or timeline (map works)" means the tree should hang every page under its `source`, the way the Web map already does, not only Deep Dives.
- Titles showing `\"` come from `serializeFrontMatter` writing JSON strings while `parseFrontMatter` only stripped the outer quotes.

### World facts
- `Selection` and `Lookup` now carry `pane: PaneRole`; `Page` filters by its role, and `ask`, `quickAnswer`, `createPage` (new `source` option) and `refine` read the page through `panePath(pane)`. `dropPaneUi("split")` runs when the split pane's page changes or closes.
- `buildTree` nests any page whose `source` is in the folder (roots newest first, children oldest first) and lists pages caught in a source cycle flat so they stay reachable.
- `parseFrontMatter` JSON-parses double-quoted values (falling back to stripping the quotes) and unescapes `''` in single-quoted ones. Files written before the fix hold valid JSON strings, so they read correctly now with no migration.
- The change cards for a pending review (Before / Now) are still drawn in the main pane only; that was not part of the report.

### Timeline
1. Pulled `origin/main` (pull request #2 had landed). Reproduced all three in the browser mock: a highlight in the split pane selected text with no box, the sidebar listed the three session pages flat, and the round trip of a quoted title kept the backslashes.
2. Made the selection pane-aware, nested the tree by `source`, fixed the parser. Updated `docs/architecture.md`.
3. Verified in the mock: the ask box opens in the split pane; ⌘↵ there grows a page whose crumb points at the split page and links the highlight in that page; ↵ puts the answer card in the split pane; ⌘R ↵ refines the split page (its strip shows 1 change, the main page untouched); closing the split drops its highlight; the sidebar and Timeline show four levels (d0–d3). A script round-tripped titles with quotes, colons, backslashes and YAML single quotes.

### Verification
- `tsc` and `pnpm build` pass. No Rust changes.
- Opened as pull request #3 from `fix/split-pane-highlights-nested-tree`.

### Possible next steps
- Show the Before / Now change cards in the split pane too, since the tints and strip already appear there.
- Keep a split-pane highlight when the main pane navigates (today `navigate` resets all of `ui`).
