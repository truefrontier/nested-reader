/**
 * The strip along the top of the window that behaves like a title bar: dragging empty space there
 * moves the window, double-clicking it zooms.
 *
 * Tauri starts that drag only when the mousedown lands on the element carrying
 * `data-tauri-drag-region` *itself*, so each band is rendered behind its own region's chrome — the
 * review strip, the pane tools, the tree toggle — and those keep their clicks. One band per region
 * rather than one overlay across the window: `.main`, `.pane` and `.side` each trap their own
 * stacking context, so a window-wide overlay can only ever paint over them, never sit under their
 * chrome, which is what left "Undo all"/"Done" unclickable (#29, #31, #41).
 */
export function DragBand() {
  return <div className="dragband" data-tauri-drag-region />;
}
