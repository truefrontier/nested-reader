import { useRef, type PointerEvent } from "react";
import type { SplitDirection } from "../platform";
import { store } from "../state/store";

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
 */
export function useSplitGrip(dir: SplitDirection) {
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
  return { onGripDown, onGripMove, onGripUp };
}
