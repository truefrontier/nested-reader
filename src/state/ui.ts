import type { Lookup, UiState, VersionView } from "./store";

export const closedVersionView: VersionView = { history: false, confirmRestore: false };

export const initialUi: UiState = {
  lookups: {},
  lastPopoverMode: "ask",
  versionView: { main: closedVersionView, split: closedVersionView },
  refines: {},
  fullscreen: false,
  syncScroll: true,
  filter: "",
  unreadOnly: false,
  changesOnly: false,
  dragging: false,
  find: false,
  findQuery: "",
  findIndex: 0,
  findFocus: 0,
  findSelect: 0,
  filterFocus: 0,
  feedbackMessage: "",
  feedbackEmail: "",
};

/**
 * The UI once the main pane has moved to another page. It is built afresh from `initialUi`, so a key
 * that belonged to the old page can't linger by being left out. What stays is what that move doesn't touch:
 * - the tree's filter and its two dots;
 * - the split pane: its version view, and a highlight there with the box open on it (a highlight in
 *   the main pane named a block of the page that just left, so it goes, box and all);
 * - `lookups`, the answer cards the caller kept (it files the main pane's away under the old page);
 * - every refine card, since those follow the work, not what is being read;
 * - the pane box (⌘R, ⌘N, feedback) and the instruction Try again reopened it with, the last ask or
 *   refine mode, and the feedback draft;
 * - a toast offering an action, so a delete can be undone after moving to another page.
 */
export function uiAfterNavigate(ui: UiState, lookups: Record<string, Lookup>): UiState {
  const split = ui.selection?.pane === "split";
  return {
    ...initialUi,
    filter: ui.filter,
    unreadOnly: ui.unreadOnly,
    changesOnly: ui.changesOnly,
    versionView: { ...initialUi.versionView, split: ui.versionView.split },
    ...(split ? { selection: ui.selection, popover: ui.popover } : {}),
    lookups,
    refines: ui.refines,
    panePopover: ui.panePopover,
    refineRetry: ui.refineRetry,
    lastPopoverMode: ui.lastPopoverMode,
    feedbackMessage: ui.feedbackMessage,
    feedbackEmail: ui.feedbackEmail,
    ...(ui.toastAction ? { error: ui.error, toastAction: ui.toastAction } : {}),
  };
}
