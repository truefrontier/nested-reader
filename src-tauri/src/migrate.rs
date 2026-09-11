//! One-time move from the identifier the app shipped with, `com.truefrontier.markdown-learner`,
//! to `app.nestedreader.nested`. The settings folder and the Keychain entries follow the
//! identifier, so the first launch under the new one copies both across. The old copies stay as
//! a backup; the Caches and WebKit folders under the old identifier are disposable.

use tauri::{AppHandle, Manager};

const OLD_IDENTIFIER: &str = "com.truefrontier.markdown-learner";
const FILES: [&str; 2] = ["settings.json", "recents.json"];
/// The providers Settings › AI stores a key for (`needsKey` in `SettingsApp.tsx`).
const KEY_PROVIDERS: [&str; 3] = ["openai", "anthropic", "custom"];

/// Runs only while the new config folder does not exist yet. Creating it closes the gate, so a
/// key deleted later is not brought back from the old service on the next launch.
pub fn run(app: &AppHandle) {
    let Ok(new_dir) = app.path().app_config_dir() else { return };
    if new_dir.exists() {
        return;
    }
    if let Err(e) = std::fs::create_dir_all(&new_dir) {
        eprintln!("migrate: could not create {}: {e}", new_dir.display());
        return;
    }
    if let Some(old_dir) = new_dir.parent().map(|p| p.join(OLD_IDENTIFIER)) {
        for name in FILES {
            let from = old_dir.join(name);
            if !from.is_file() {
                continue;
            }
            if let Err(e) = std::fs::copy(&from, new_dir.join(name)) {
                eprintln!("migrate: could not copy {}: {e}", from.display());
            }
        }
    }
    for provider in KEY_PROVIDERS {
        if let Err(e) = copy_key(provider) {
            eprintln!("migrate: could not copy the {provider} key: {e}");
        }
    }
}

fn copy_key(provider: &str) -> std::result::Result<(), keyring::Error> {
    let secret = match keyring::Entry::new(OLD_IDENTIFIER, provider)?.get_password() {
        Ok(s) => s,
        Err(keyring::Error::NoEntry) => return Ok(()),
        Err(e) => return Err(e),
    };
    keyring::Entry::new(crate::ai::KEYCHAIN_SERVICE, provider)?.set_password(&secret)
}
