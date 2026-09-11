# Progress

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
