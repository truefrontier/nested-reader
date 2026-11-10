import { useEffect, type RefObject } from "react";

type Scroller = Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">;

/**
 * The scrollTop that puts `dst` at the same fraction of its scroll range as `src`, rounded to a whole
 * pixel. Null when either has nothing to scroll, or `dst` is already within a pixel of it: setting it
 * anyway would echo back as a scroll on `dst` and start the two panes chasing each other.
 */
export function followScrollTop(src: Scroller, dst: Scroller): number | null {
  const srcMax = src.scrollHeight - src.clientHeight;
  const dstMax = dst.scrollHeight - dst.clientHeight;
  if (srcMax <= 0 || dstMax <= 0) return null;
  const target = Math.round((src.scrollTop / srcMax) * dstMax);
  return Math.abs(dst.scrollTop - target) < 1 ? null : target;
}

/** A scroll container, as `linkScroll` uses it. */
type Pane = Scroller & {
  addEventListener(type: "scroll", listener: () => void, options?: AddEventListenerOptions): void;
  removeEventListener(type: "scroll", listener: () => void): void;
};

/**
 * Makes each of two panes follow the other's scrolling, and lines `split` up with `main` straight away.
 * Returns the function that unlinks them.
 */
export function linkScroll(main: Pane, split: Pane): () => void {
  // Where we last put each pane. Its next scroll event, if the pane is still there, is that write coming
  // back, and following it would round the reader's own pane to a new place. Told apart by place, not by
  // frame: the event can come a frame after the write.
  const placed = new Map<Pane, number>();
  const follow = (src: Pane, dst: Pane) => {
    const target = followScrollTop(src, dst);
    if (target === null) return;
    dst.scrollTop = target;
    placed.set(dst, dst.scrollTop);
  };
  const onScroll = (src: Pane, dst: Pane) => () => {
    const at = placed.get(src);
    placed.delete(src);
    if (at !== undefined && Math.abs(src.scrollTop - at) < 1) return;
    follow(src, dst);
  };
  const onMain = onScroll(main, split);
  const onSplit = onScroll(split, main);
  main.addEventListener("scroll", onMain, { passive: true });
  split.addEventListener("scroll", onSplit, { passive: true });
  follow(main, split);
  return () => {
    main.removeEventListener("scroll", onMain);
    split.removeEventListener("scroll", onSplit);
  };
}

/**
 * Links the scrolling of the two panes inside `container` while `active` is true. Each pane follows the
 * other in proportion: the narrower pane wraps the same page into more lines (beside, the split is
 * usually the taller), so matching scroll fractions keeps the same part of the text in view on both sides.
 */
export function useSyncScroll(container: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    const root = container.current;
    if (!active || !root) return;
    const main = root.querySelector<HTMLElement>(":scope > .pane:not(.split)");
    const split = root.querySelector<HTMLElement>(":scope > .pane.split");
    if (!main || !split) return;
    return linkScroll(main, split);
  }, [container, active]);
}
