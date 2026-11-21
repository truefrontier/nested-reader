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

- Rust check:
- Rust clippy:
- Frontend build:
- Frontend tests:
- Launch:
