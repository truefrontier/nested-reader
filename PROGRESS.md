# Progress

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
