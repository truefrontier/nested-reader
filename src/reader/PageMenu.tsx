import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { store, useReader } from "../state/store";
import { AnchoredLayer, DeleteConfirm } from "./AnchoredLayer";
import { MoreIcon } from "./Icons";
import { RenameInput } from "./RenameInput";
import { onEscapeFirst } from "../lib/escapeFirst";

type Mode = "menu" | "rename" | "delete";

/**
 * The ⋯ on a pane's tools: Rename, Reveal in Finder and Delete for the page in that pane, through the
 * same store actions, rename box and delete confirmation as the tree row's ⋯ menu, so a page can be
 * handled without the tree. The arrow keys move through the menu, Esc closes it, and after a keyboard
 * choice the keyboard goes back to the ⋯.
 */
export function PageMenu({ path }: { path: string }) {
  const s = useReader();
  const title = s.pages[path]?.title;
  const [mode, setMode] = useState<Mode | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  // Whether the keyboard is driving, so focus only moves for someone using it.
  const kb = useRef(false);

  // Another page in the pane closes whatever was open.
  useEffect(() => setMode(null), [path]);

  const close = () => {
    setMode(null);
    if (kb.current) button.current?.focus();
  };

  // The layer is hidden until it has been placed, and a hidden element takes no focus, so focus waits a frame.
  // From the keyboard the first item (or Cancel) takes it; from a click the layer itself does, so the
  // arrow keys and Esc still reach it without lighting an item. The rename box always does.
  useEffect(() => {
    if (!mode) return;
    const id = requestAnimationFrame(() => {
      const el = layer.current;
      const target = mode === "rename" ? el?.querySelector("input") : !kb.current ? el : el?.querySelector<HTMLElement>(mode === "menu" ? "[role=menuitem]" : ".acts .c");
      target?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [mode]);

  // A click anywhere else closes the menu or the confirmation, and so does Esc, caught before the window's
  // own Esc can also close the find bar or cancel a refine. The rename box closes itself on blur, keeping the name.
  useEffect(() => {
    if (mode !== "menu" && mode !== "delete") return;
    const onDown = () => setMode(null);
    window.addEventListener("mousedown", onDown);
    const stopEscape = onEscapeFirst(window, () => {
      kb.current = true;
      close();
    });
    return () => {
      window.removeEventListener("mousedown", onDown);
      stopEscape();
    };
  }, [mode]);

  if (!title) return null;

  // Keys pressed inside a layer stay there, so Enter on an item doesn't also retry a failed page.
  const onLayerKey = (e: KeyboardEvent) => {
    kb.current = true;
    if (!e.metaKey) e.stopPropagation();
    if (mode !== "menu") return;
    if (e.key === "Tab") {
      e.preventDefault();
      close();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const items = [...(layer.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    const last = items.length - 1;
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? last : e.key === "ArrowDown" ? (at < last ? at + 1 : 0) : at > 0 ? at - 1 : last;
    items[next]?.focus();
  };

  // Delete asks first, as it does from the tree, until "Do not ask again" has been ticked once.
  const askDelete = () => {
    if (s.settings.confirmDelete) return setMode("delete");
    close();
    void store.deletePage(path);
  };

  const anchor = button.current ?? undefined;
  return (
    <>
      <button
        ref={button}
        className={`tbtn${mode ? " open" : ""}`}
        title="Rename, reveal or delete"
        aria-label="Page menu"
        aria-haspopup="menu"
        aria-expanded={mode === "menu"}
        onMouseDown={(e: MouseEvent) => e.stopPropagation()}
        // Enter and Space press the button; they shouldn't also reach the window's ↵ for a failed page.
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && e.stopPropagation()}
        onClick={(e) => {
          // A click from Enter or Space has no mouse presses behind it.
          kb.current = e.detail === 0;
          setMode(mode ? null : "menu");
        }}
      >
        <MoreIcon />
      </button>
      {mode === "menu" && (
        <AnchoredLayer anchor={anchor} className="row-menu">
          <div ref={layer} role="menu" aria-label={`Page “${title}”`} tabIndex={-1} onKeyDown={onLayerKey}>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="item"
              onClick={() => {
                // Only Enter or Esc in the box hands the keyboard back; a click elsewhere keeps its own focus.
                kb.current = false;
                setMode("rename");
              }}
            >
              Rename
            </button>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="item"
              onClick={() => {
                close();
                void store.revealPage(path);
              }}
            >
              Reveal in Finder
            </button>
            <div className="sep" role="separator" />
            <button type="button" role="menuitem" tabIndex={-1} className="item warn" onClick={askDelete}>
              Delete
            </button>
          </div>
        </AnchoredLayer>
      )}
      {mode === "rename" && (
        <AnchoredLayer anchor={anchor} className="row-menu pane-rename">
          <div
            ref={layer}
            onKeyDownCapture={(e) => {
              if (e.key !== "Enter" && e.key !== "Escape") return;
              kb.current = true;
              // Enter's keypress would otherwise land on the ⋯ once it has the focus back, and open the menu again.
              if (e.key === "Enter") e.preventDefault();
            }}
          >
            <RenameInput
              value={title}
              label="Page title"
              onDone={(name) => {
                close();
                if (name !== null) void store.renamePage(path, name);
              }}
            />
          </div>
        </AnchoredLayer>
      )}
      {mode === "delete" && (
        <AnchoredLayer anchor={anchor} className="row-confirm pane-confirm">
          <div ref={layer} role="dialog" aria-label="Delete page" tabIndex={-1} onKeyDown={onLayerKey}>
            <DeleteConfirm
              title={title}
              onCancel={close}
              onDelete={(dontAsk) => {
                close();
                void store.deletePage(path, dontAsk);
              }}
            />
          </div>
        </AnchoredLayer>
      )}
    </>
  );
}
