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
 */
export function useSplitGrip(dir: SplitDirection) {
  const drag = useRef<{ at: number; split: number; size: number } | null>(null);
  const share = (e: PointerEvent) => {
    const d = drag.current!;
    const px = d.split - ((dir === "beside" ? e.clientX : e.clientY) - d.at);
    // Too narrow for both minimums, the split keeps its own, as `min-width` beats `max-width` in the CSS.
    return (Math.max(MIN[dir].split, Math.min(d.size - MIN[dir].main, px)) / d.size) * 100;
  };
  const onGripDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const main = e.currentTarget.parentElement!.getBoundingClientRect();
    const pane = e.currentTarget.nextElementSibling!.getBoundingClientRect();
    drag.current = dir === "beside" ? { at: e.clientX, split: pane.width, size: main.width } : { at: e.clientY, split: pane.height, size: main.height };
  };
  const onGripMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current) store.previewSplitShare(dir, share(e));
  };
  const onGripUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const pct = share(e);
    drag.current = null;
    void store.setSplitShare(dir, pct);
  };
  return { onGripDown, onGripMove, onGripUp };
}
