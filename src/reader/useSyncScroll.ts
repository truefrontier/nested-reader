import { useEffect, type RefObject } from "react";

/**
 * Links the scrolling of the two panes inside `container` while `active` is true. Each pane follows the
 * other in proportion: the same page renders a little taller in the main pane than in the split, so
 * matching scroll fractions keeps the same part of the text in view on both sides.
 */
export function useSyncScroll(container: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    const root = container.current;
    if (!active || !root) return;
    const main = root.querySelector<HTMLElement>(":scope > .pane:not(.split)");
    const split = root.querySelector<HTMLElement>(":scope > .pane.split");
    if (!main || !split) return;

    // The pane whose scrollTop was just set by us; its echoed scroll event is dropped so the two don't feed each other.
    let echo: HTMLElement | null = null;
    const follow = (src: HTMLElement, dst: HTMLElement) => {
      const srcMax = src.scrollHeight - src.clientHeight;
      const dstMax = dst.scrollHeight - dst.clientHeight;
      if (srcMax <= 0 || dstMax <= 0) return;
      const target = Math.round((src.scrollTop / srcMax) * dstMax);
      if (Math.abs(dst.scrollTop - target) < 1) return;
      echo = dst;
      dst.scrollTop = target;
      requestAnimationFrame(() => {
        if (echo === dst) echo = null;
      });
    };
    const onScroll = (src: HTMLElement, dst: HTMLElement) => () => {
      if (echo === src) {
        echo = null;
        return;
      }
      follow(src, dst);
    };
    const onMain = onScroll(main, split);
    const onSplit = onScroll(split, main);
    main.addEventListener("scroll", onMain, { passive: true });
    split.addEventListener("scroll", onSplit, { passive: true });
    // Line the split up with the main pane as soon as the link is made.
    follow(main, split);
    return () => {
      main.removeEventListener("scroll", onMain);
      split.removeEventListener("scroll", onSplit);
    };
  }, [container, active]);
}
