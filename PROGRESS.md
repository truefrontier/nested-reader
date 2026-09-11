# Progress

## Leading assumptions
- "Like Refining with full session context, but it's a new file" means: ⌘N opens the same bottom box as a page or corpus refine, takes a brief instead of a highlight, and writes a brand-new `.md` using the current page plus the session pages as context.
- The new page hangs off the page you were reading (`source`), so it stays inside the session and inside a file session. Nothing is linked in the source, since there is no highlight.
- The Context toggles in Settings still decide what leaves the machine. ⌘N does not override them; with "Other pages in this session" on (the default) the whole session goes with the request.
- ⌘N verbs follow the ask popover's grammar: ↵ opens the page here, ⌘↵ uses the New Page placement, ⌘⇧↵ writes a longer Deep Dive at its placement, ⌥ flips either.
- This task supersedes `claude/upbeat-davinci-pezf5c`, which added a "New session" (⌘O) button to the foot of the session sidebar. That button is not carried over; a "New page ⌘N" button sits in that spot instead.

## World facts
- App: Tauri 2 + React + Vite. Reader state lives in `src/state/store.ts`, popovers in `src/reader/Popovers.tsx`, prompts in `src/lib/prompts.ts`, the native menu in `src-tauri/src/lib.rs`.
- The ⌘R key is handled in the webview, not as a menu accelerator, so it also works inside the ask box. ⌘N follows the same pattern: File › "New Page… (⌘N)" has no accelerator.
- `ui.panePopover` was a boolean; it is now `"refine" | "new" | undefined`.
- `createPage` and `generatePage` take `from: "session"` to pick `newFileMessages` over `newPageMessages`. A retry tells the two apart by whether the source page holds a `[[slug|text]]` link to the page.
- The mock backend (`pnpm dev`) recognises the new prompt ("adding a new page") and the "New page:" line so browser previews stream sample text.
- The Rust side cannot be compiled in this container (missing GTK dev libraries); the Rust change is two menu-builder lines.

## Timeline
1. 2026-09-11: User asked for ⌘N to work like Refining with full session context, but producing a new file. Mid-task the user said this task supersedes `claude/upbeat-davinci-pezf5c`.
2. Read the store, popovers, prompts, menu, and docs. Chose to reuse the bottom pane box and the New Page / Deep Dive placements.
3. Added `newFileMessages`, `newFile`, `toggleNewFile`, the `"new-page"` command, `NewFilePopover`, the ⌘N key handler, the File menu item, and the sidebar button.
4. Verified in the browser with Playwright: the box opens and closes on ⌘N, ↵ writes a page here with three paragraphs, ⌘⇧↵ hangs a Deep Dive branch under the current page, a failed page retries through the session route, ⌘N from inside the ask box swaps to the new box, Esc closes it.
5. Type check and production build pass. Updated README and `docs/architecture.md`.

## Possible next steps
- Let ⌘N inside the refine box swap to the new-page box and back, the way ⌘R swaps ask and refine.
- Show a status card for a ⌘N page sent to the background, since the only signal today is the tree's loading dot and a toast on failure.
- Consider recording the origin in front matter (rather than inferring it from the missing link) if other origins appear later.
