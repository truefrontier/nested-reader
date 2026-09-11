# PROGRESS

## Session: split-pane back link closes the child page

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

### Possible next steps
- Decide whether the same rule should apply in reverse: the main pane's crumb when the parent is open in the split pane. Left unchanged, since the request was about the split panel.
- Consider the case where the parent is not current but is elsewhere in the trail. Left as a plain navigate.
