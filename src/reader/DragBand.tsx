/**
 * The band that behaves like a title bar: dragging it moves the window, double-clicking it zooms.
 * The reader's topbar, Home and the Settings window each lay one behind their own chrome.
 *
 * Tauri starts that drag only when the mousedown lands on the element carrying
 * `data-tauri-drag-region` *itself*, so whatever sits over the band would swallow the drag. The
 * title and status in the topbar are therefore `pointer-events: none`, and only the buttons over
 * the band take their clicks back.
 */
export function DragBand() {
  return <div className="dragband" data-tauri-drag-region />;
}
