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
