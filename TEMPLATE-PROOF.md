# TF Mac App template baseline proof

Template reference: `tf-mac-app` main at `b477db9` (read-only snapshot).

| Baseline item | Nested implementation | Template source | Status |
| --- | --- | --- | --- |
| Analytics (Aptabase) | `src-tauri/src/analytics.rs`; Settings > General privacy controls | `src-tauri/src/analytics.rs` | adopted |
| Updater, minisign, release feed | `src-tauri/src/updater.rs`, `src-tauri/tauri.conf.json`, `src/reader/UpdateBar.tsx` | `src-tauri/src/updater.rs`, `src-tauri/tauri.conf.json` | already present |
| Settings panel | `src/settings/SettingsApp.tsx`, `src/platform/types.ts` | `src/settings/SettingsApp.tsx` | adopted |
| Keyboard shortcuts | `src/lib/shortcuts.ts`, `src/App.tsx`, `src-tauri/src/lib.rs`; Help uses ⌘? and Send Feedback has no accelerator | `src/lib/shortcuts.ts` | adopted |
| Feedback triage | `src-tauri/src/feedback.rs`, `src/reader/Popovers.tsx`, configured relay | `src-tauri/src/feedback.rs`, `feedback-relay/` | already present |
| Opt-in crash reporting | `src/lib/crashReporting.ts`, Settings > General privacy controls | `src/lib/crashReporting.ts` | adopted |
| Single-instance lock | `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs` | `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs` | adopted |
| Diagnostics export | `src-tauri/src/diagnostics.rs`, `src/settings/SettingsApp.tsx` | `src-tauri/src/diagnostics.rs` | adopted |

## Not adopted

Nested’s updater endpoint, minisign public key, bundle identifier, version, and signing/release configuration remain unchanged by design. Its existing feedback flow supports screenshot attachments, so the template’s simpler dialog/relay stub was not substituted. Nested keeps its product-specific settings layout and richer shortcuts; the shared baseline privacy and diagnostics controls were added to it.

## Build and launch evidence

Run on Kevin's M4 (macOS, arm64), Sat Nov 21, 2026, on branch `feat/tf-template-baseline` at `f345a45`.

- `pnpm install --frozen-lockfile`: ok
- `pnpm build` (`tsc && vite build`): ok
- `pnpm test`: 190 tests, 190 pass, 0 fail
- `cd src-tauri && cargo check`: ok
- `cd src-tauri && cargo clippy --all-targets -- -D warnings`: ok (no warnings)
- `pnpm tauri build --no-bundle` (unsigned, not notarized, no bundle, no updater artifacts): ok, release build in 2m 16s
  - Output: `src-tauri/target/release/nested` (Mach-O 64-bit arm64, ~14.9 MB)
- Launch: ran `src-tauri/target/release/nested` directly. The process stayed up, the support log printed
  `[nested_support][INFO] application_ready`, macOS listed an on-screen 1120x720 window titled "Nested",
  and the menu bar showed `Nested, File, Edit, View, Go, Window, Help` (Help is new).
- Single-instance lock: a second launch of the same binary exited by itself (code 0) within 5 seconds while the first kept running.
- Not run: signing, notarization, `.app`/`.dmg` bundling, release or tag. Those need Kevin's OK.
