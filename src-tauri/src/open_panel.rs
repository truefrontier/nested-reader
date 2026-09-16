//! The Open panel behind ⌘O and ⌘⇧O: one NSOpenPanel that takes either folders or Markdown
//! files. `rfd`, behind the dialog plugin, only offers one or the other per panel.

use objc2::MainThreadMarker;
use objc2_app_kit::{NSModalResponseOK, NSOpenPanel};
use objc2_foundation::{NSArray, NSString};

/// Shows the panel and waits for it. Resolves to the chosen paths, empty when cancelled.
/// `multiple` allows picking more than one (⌘⇧O, "Add to Session…"); ⌘O stays single-selection
/// and only the first path is used. `message` is the line above the file list. Must run on the
/// main thread: the panel is an AppKit window.
pub fn folder_or_markdown(message: &str, multiple: bool) -> Vec<String> {
    let mtm = MainThreadMarker::new().expect("the Open panel runs on the main thread");
    let panel = NSOpenPanel::openPanel(mtm);
    panel.setCanChooseFiles(true);
    panel.setCanChooseDirectories(true);
    panel.setAllowsMultipleSelection(multiple);
    panel.setResolvesAliases(true);
    panel.setMessage(Some(&NSString::from_str(message)));
    // Only files are filtered; folders stay selectable. The typed replacement needs UTType.
    let types = NSArray::from_retained_slice(&[NSString::from_str("md"), NSString::from_str("markdown")]);
    #[allow(deprecated)]
    panel.setAllowedFileTypes(Some(&types));
    if panel.runModal() != NSModalResponseOK {
        return Vec::new();
    }
    panel.URLs().iter().filter_map(|url| url.path()).map(|p| p.to_string()).collect()
}
