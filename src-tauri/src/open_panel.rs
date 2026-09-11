//! The Open panel behind ⌘O: one NSOpenPanel that takes either a folder or a single Markdown
//! file. `rfd`, behind the dialog plugin, only offers one or the other per panel.

use objc2::MainThreadMarker;
use objc2_app_kit::{NSModalResponseOK, NSOpenPanel};
use objc2_foundation::{NSArray, NSString};

/// Shows the panel and waits for it. Resolves to the chosen path, or None when cancelled.
/// Must run on the main thread: the panel is an AppKit window.
pub fn folder_or_markdown() -> Option<String> {
    let mtm = MainThreadMarker::new().expect("the Open panel runs on the main thread");
    let panel = NSOpenPanel::openPanel(mtm);
    panel.setCanChooseFiles(true);
    panel.setCanChooseDirectories(true);
    panel.setAllowsMultipleSelection(false);
    panel.setResolvesAliases(true);
    panel.setMessage(Some(&NSString::from_str("Open a folder of Markdown notes, or a single .md file.")));
    // Only files are filtered; folders stay selectable. The typed replacement needs UTType.
    let types = NSArray::from_retained_slice(&[NSString::from_str("md"), NSString::from_str("markdown")]);
    #[allow(deprecated)]
    panel.setAllowedFileTypes(Some(&types));
    if panel.runModal() != NSModalResponseOK {
        return None;
    }
    panel.URL().and_then(|url| url.path()).map(|p| p.to_string())
}
