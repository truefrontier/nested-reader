import { useRef, type PointerEvent } from "react";
import { store } from "../state/store";

/**
 * Drag the sidebar's right edge to resize; the width is saved when the pointer is let go. Shared by
 * `Sidebar` and `Home`, whose side panels both resize through the same `settings.sidebarWidth`.
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
  return { onGripDown, onGripMove, onGripUp };
}
