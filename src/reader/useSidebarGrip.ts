import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { store } from "../state/store";
import { DEFAULT_SETTINGS, SIDEBAR_WIDTH_RANGE } from "../platform";
import { gripKey } from "../lib/keys";

/**
 * Drag the sidebar's right edge to resize; the width is saved when the pointer is let go. Shared by
 * `Sidebar` and `Home`, whose side panels both resize through the same `settings.sidebarWidth`.
 * From the keyboard the edge is a `separator`: ← → move it 16px (80 with ⇧), Home and End go to the
 * narrowest and widest, and ↵ puts it back, as a double-click does. `gripProps` carries all of that.
 */
export function useSidebarGrip(width: number) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const onGripDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, width: e.currentTarget.parentElement?.getBoundingClientRect().width ?? width };
  };
  const onGripMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    store.previewSidebarWidth(drag.current.width + e.clientX - drag.current.x);
  };
  const onGripUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const next = drag.current.width + e.clientX - drag.current.x;
    drag.current = null;
    void store.setSidebarWidth(next);
  };
  const onGripKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = e.key === "Enter" ? DEFAULT_SETTINGS.sidebarWidth : gripKey(e.key, e.shiftKey, width, SIDEBAR_WIDTH_RANGE, 16, "ArrowRight");
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    void store.setSidebarWidth(next);
  };
  const gripProps = {
    role: "separator",
    "aria-orientation": "vertical",
    "aria-label": "Sidebar width",
    "aria-valuenow": width,
    "aria-valuemin": SIDEBAR_WIDTH_RANGE.min,
    "aria-valuemax": SIDEBAR_WIDTH_RANGE.max,
    tabIndex: 0,
    onPointerDown: onGripDown,
    onPointerMove: onGripMove,
    onPointerUp: onGripUp,
    onPointerCancel: onGripUp,
    onKeyDown: onGripKey,
    onDoubleClick: () => void store.setSidebarWidth(DEFAULT_SETTINGS.sidebarWidth),
  } as const;
  return { gripProps };
}
