import { useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

const stop = (e: MouseEvent) => e.stopPropagation();

export const EDGE = 8;
/** The old `top: 26px` on a 28px row: tuck the layer 2px over the row's edge. */
const TUCK = 2;

/**
 * A ⋯ menu or delete confirmation, for a tree row or a pane's page menu. Drawn on `document.body`
 * so `.tree`'s overflow cannot clip it, and flipped above the anchor when there is no room below.
 */
export function AnchoredLayer({
  anchor,
  className,
  stretch,
  children,
}: {
  anchor: HTMLElement | undefined;
  className: string;
  stretch?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ top: number; left: number; width?: number; up: boolean } | null>(null);

  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu || !anchor) return;

    const place = () => {
      const a = anchor.getBoundingClientRect();
      let width: number | undefined;
      if (stretch) {
        const inner = anchor.closest(".tree-inner");
        const left0 = (inner?.getBoundingClientRect().left ?? a.left) - 2;
        width = Math.max(148, a.right - 8 - left0);
        menu.style.width = `${width}px`;
      } else {
        menu.style.width = "";
      }
      const mh = menu.offsetHeight;
      const mw = width ?? menu.offsetWidth;
      const spaceBelow = window.innerHeight - a.bottom;
      const spaceAbove = a.top;
      const up = spaceBelow < mh + EDGE && spaceAbove > spaceBelow;
      let top = up ? a.top - mh + TUCK : a.bottom - TUCK;
      top = Math.max(EDGE, Math.min(top, window.innerHeight - mh - EDGE));
      let left = stretch ? (anchor.closest(".tree-inner")?.getBoundingClientRect().left ?? a.left) - 2 : a.right - 8 - mw;
      left = Math.max(EDGE, Math.min(left, window.innerWidth - mw - EDGE));
      setBox({ top, left, width, up });
    };

    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor, stretch]);

  if (!anchor) return null;

  return createPortal(
    <div
      ref={ref}
      className={`${className}${box?.up ? " up" : ""}${box ? " placed" : ""}`}
      data-flip={box ? (box.up ? "up" : "down") : undefined}
      style={{
        position: "fixed",
        top: box?.top ?? 0,
        left: box?.left ?? 0,
        right: "auto",
        width: box?.width,
        visibility: box ? "visible" : "hidden",
      }}
      onMouseDown={stop}
      onClick={stop}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </div>,
    document.body,
  );
}

/**
 * The body of a delete confirmation, in a `.row-confirm` layer, for a tree row and a pane's page
 * menu. Its "Do not ask again" box starts clear each time it opens, so a tick never carries over unseen.
 */
export function DeleteConfirm({ title, onCancel, onDelete }: { title: string; onCancel: () => void; onDelete: (dontAsk: boolean) => void }) {
  const [dontAsk, setDontAsk] = useState(false);
  return (
    <>
      <div>Delete “{title}”?</div>
      <div className="sub">
        Its file moves to <code>.reader/trash</code> inside the folder.
      </div>
      <label className="again">
        <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />
        Do not ask again
      </label>
      <div className="acts">
        <button type="button" className="c" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="d" onClick={() => onDelete(dontAsk)}>
          Delete
        </button>
      </div>
    </>
  );
}
