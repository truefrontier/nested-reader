# Progress

## Leading assumptions
- The session sidebar and the home sidebar share the same width, background, and padding, so the `.home-new` button style works unchanged in both.
- ⌘O opens a folder from anywhere in the app, so the shortcut hint on the button is accurate inside a session.
- "New session" means the same action as on the home screen: pick a folder.

## World facts
- App: Tauri + React + Vite. Reader UI lives in `src/reader/`, styles in `src/styles/app.css`, state in `src/state/store.ts`.
- `Home.tsx` renders the home sidebar with a "New session" button at the bottom.
- `Sidebar.tsx` renders the in-session page tree sidebar.
- A mock platform serves sample content in the browser, which makes screenshots easy with Playwright from `/opt/node22/lib/node_modules/playwright`.

## Timeline
1. 2026-09-11: User asked for the New Session button to also show at the bottom of the non-home sidebar.
2. Added the same button to the bottom of `Sidebar.tsx`, reusing the `.home-new` style and `PlusIcon`.
3. Type-check and production build pass. Screenshot confirms the button sits at the bottom of the session sidebar.
4. Committed and pushed to `claude/upbeat-davinci-pezf5c`.

## Possible next steps
- Rename `.home-new` to something sidebar-neutral now that both sidebars use it.
- Decide whether the button should offer "Open file…" too, matching the home screen's two cards.
