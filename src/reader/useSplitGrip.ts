import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { DEFAULT_SETTINGS, SPLIT_SHARE_RANGE, splitSharePct, type SplitDirection } from "../platform";
import { store } from "../state/store";
import { gripKey } from "../lib/keys";

/** The smallest each pane is dragged to, in px; the same limits are the `.pane.split` min and max in app.css. */
const MIN: Record<SplitDirection, { split: number; main: number }> = {
  beside: { split: 260, main: 320 },
  below: { split: 160, main: 160 },
};

/**
 * Drag the edge between the main and split panes to resize the split; its share of `.main` is saved
 * when the pointer is let go. The grip sits just before `.pane.split`, so its next sibling is the pane.
 * A press that never moves changes nothing: the CSS `min-*` / `max-*` can hold the pane away from the
 * saved share (26% of `.main` at the 1120px launch size is under 260px), and saving that rendered size
 * back would leave the split too big once the window widens.
 * From the keyboard the edge is a `separator`: ← → (↑ ↓ when the split is below) move it 24px (120 with
 * ⇧) from where the pane is drawn, within the same limits, Home and End go to them, and ↵ puts back the
 * default share, as a double-click does. `gripProps` carries all of that.
 */
export function useSplitGrip(dir: SplitDirection, saved: number) {
  const drag = useRef<{ at: number; split: number; size: number; moved: boolean } | null>(null);
  const at = (e: PointerEvent) => (dir === "beside" ? e.clientX : e.clientY);
  const share = (e: PointerEvent) => {
    const d = drag.current!;
    const px = d.split - (at(e) - d.at);
    // Too narrow for both minimums, the split keeps its own, as `min-width` beats `max-width` in the CSS.
    return (Math.max(MIN[dir].split, Math.min(d.size - MIN[dir].main, px)) / d.size) * 100;
  };
  const onGripDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const main = e.currentTarget.parentElement!.getBoundingClientRect();
    const pane = e.currentTarget.nextElementSibling!.getBoundingClientRect();
    const [split, size] = dir === "beside" ? [pane.width, main.width] : [pane.height, main.height];
    drag.current = { at: at(e), split, size, moved: false };
  };
  const onGripMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d && (d.moved ||= at(e) !== d.at)) store.previewSplitShare(dir, share(e));
  };
  const onGripUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const pct = share(e);
    drag.current = null;
    if (d.moved) void store.setSplitShare(dir, pct);
  };
  const onGripKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      void store.setSplitShare(dir, DEFAULT_SETTINGS.splitShare[dir]);
      return;
    }
    const main = e.currentTarget.parentElement!.getBoundingClientRect();
    const pane = e.currentTarget.nextElementSibling!.getBoundingClientRect();
    const [split, size] = dir === "beside" ? [pane.width, main.width] : [pane.height, main.height];
    const px = gripKey(e.key, e.shiftKey, split, { min: MIN[dir].split, max: size - MIN[dir].main }, 24, dir === "beside" ? "ArrowLeft" : "ArrowUp");
    if (px === null) return;
    e.preventDefault();
    e.stopPropagation();
    void store.setSplitShare(dir, (px / size) * 100);
  };
  const gripProps = {
    role: "separator",
    // The handle between panes beside each other is upright; between panes one above the other, it lies flat.
    "aria-orientation": dir === "beside" ? "vertical" : "horizontal",
    "aria-label": "Split pane size",
    "aria-valuenow": splitSharePct({ [dir]: saved }, dir),
    "aria-valuemin": SPLIT_SHARE_RANGE.min,
    "aria-valuemax": SPLIT_SHARE_RANGE.max,
    "aria-valuetext": `${Math.round(splitSharePct({ [dir]: saved }, dir))}%`,
    tabIndex: 0,
    onPointerDown: onGripDown,
    onPointerMove: onGripMove,
    onPointerUp: onGripUp,
    onPointerCancel: onGripUp,
    onKeyDown: onGripKey,
    onDoubleClick: () => void store.setSplitShare(dir, DEFAULT_SETTINGS.splitShare[dir]),
  } as const;
  return { gripProps };
}
