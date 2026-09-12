//! Nested as the Mac's app for Markdown files: which app opens `.md` today, and on request,
//! asking macOS to make it Nested. macOS 26.4 and later confirm every such change with the
//! user (Use / Keep), so the answer is read back after the call rather than assumed.

use block2::RcBlock;
use objc2::rc::Retained;
use objc2_app_kit::NSWorkspace;
use objc2_foundation::{NSBundle, NSError, NSString, NSURL};
use objc2_uniform_type_identifiers::UTType;
use serde::Serialize;
use std::sync::Mutex;
use tokio::sync::oneshot;

/// The type every Markdown-aware Mac app agrees on. `src-tauri/Info.plist` imports it, so it
/// exists even on a Mac where no other app declares it.
pub const MARKDOWN_UTI: &str = "net.daringfireball.markdown";

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct DefaultApp {
    /// The app that opens .md files today ("Typora"), or None when no app does.
    pub app: Option<String>,
    pub is_nested: bool,
    /// False under `tauri dev`: a bare executable is not a bundle macOS can register.
    pub available: bool,
}

fn markdown_type() -> Option<Retained<UTType>> {
    UTType::typeWithIdentifier(&NSString::from_str(MARKDOWN_UTI))
}

/// This app's bundle, when it is one.
fn own_bundle() -> Option<Retained<NSURL>> {
    let url = NSBundle::mainBundle().bundleURL();
    (url.pathExtension()?.to_string() == "app").then_some(url)
}

fn app_name(url: &NSURL) -> Option<String> {
    let name = url.lastPathComponent()?.to_string();
    Some(name.strip_suffix(".app").unwrap_or(&name).to_owned())
}

/// Which app opens Markdown files right now. `identifier` is this app's bundle identifier.
pub fn current(identifier: &str) -> DefaultApp {
    let available = own_bundle().is_some();
    let Some(markdown) = markdown_type() else {
        return DefaultApp { available, ..DefaultApp::default() };
    };
    let handler = NSWorkspace::sharedWorkspace().URLForApplicationToOpenContentType(&markdown);
    let is_nested = handler
        .as_deref()
        .and_then(NSBundle::bundleWithURL)
        .and_then(|b| b.bundleIdentifier())
        .is_some_and(|id| id.to_string() == identifier);
    DefaultApp { app: handler.as_deref().and_then(app_name), is_nested, available }
}

/// Asks macOS to make this app the default for Markdown. Runs on the main thread, since the
/// consent prompt is a window; `tx` gets the error message, or None once macOS has answered.
/// None also covers the user keeping the old app, so read `current` afterwards.
pub fn request(tx: oneshot::Sender<Option<String>>) {
    let (Some(bundle), Some(markdown)) = (own_bundle(), markdown_type()) else {
        let _ = tx.send(Some("Run the built app (Nested.app) to make it the default.".into()));
        return;
    };
    let slot = Mutex::new(Some(tx));
    let done: RcBlock<dyn Fn(*mut NSError)> = RcBlock::new(move |err: *mut NSError| {
        // SAFETY: macOS passes either null or a live NSError for the duration of the call.
        let message = unsafe { err.as_ref() }.map(|e| e.localizedDescription().to_string());
        if let Some(tx) = slot.lock().unwrap().take() {
            let _ = tx.send(message);
        }
    });
    NSWorkspace::sharedWorkspace().setDefaultApplicationAtURL_toOpenContentType_completionHandler(&bundle, &markdown, Some(&done));
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reads this Mac's real default, so it needs a Mac with some Markdown app and is run by hand:
    /// `cargo test --lib default_app -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn reads_the_current_default() {
        let state = current("app.nestedreader.nested");
        println!("{state:?}");
        assert!(state.app.is_some(), "some app opens Markdown");
        assert!(!state.is_nested, "the test binary is not the registered Nested.app");
        assert!(!state.available, "a test binary is not an app bundle");
    }
}
