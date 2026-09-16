import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { store, useReader } from "../state/store";
import { buildFolders, dotState, rootDirs, type FolderNode, type TreeItem } from "../lib/tree";
import { ChevronLeft, ChevronRight, MoreIcon } from "./Icons";
import { RenameInput } from "./RenameInput";
import { DEFAULT_SETTINGS } from "../platform";

const stop = (e: MouseEvent) => e.stopPropagation();

const EDGE = 8;
/** The old `top: 26px` on a 28px row: tuck the layer 2px over the row's edge. */
const TUCK = 2;

/**
 * The tree's ⋯ menu and delete confirmation. Drawn on `document.body` so `.tree`'s overflow
 * cannot clip them, and flipped above the row when there is no room below.
 */
function AnchoredLayer({
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
 * A single-item menu that opens at the cursor, for the tree's empty area. Unlike `AnchoredLayer`,
 * which right-aligns under a row, this one just clamps to the viewport around the click point.
 */
function PointMenu({ at, children }: { at: { x: number; y: number } | null; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    setBox(null);
    const menu = ref.current;
    if (!menu || !at) return;
    const left = Math.max(EDGE, Math.min(at.x, window.innerWidth - menu.offsetWidth - EDGE));
    const top = Math.max(EDGE, Math.min(at.y, window.innerHeight - menu.offsetHeight - EDGE));
    setBox({ top, left });
  }, [at]);

  if (!at) return null;

  return createPortal(
    <div
      ref={ref}
      className={`row-menu${box ? " placed" : ""}`}
      style={{ position: "fixed", top: box?.top ?? at.y, left: box?.left ?? at.x, visibility: box ? "visible" : "hidden" }}
      onMouseDown={stop}
      onClick={stop}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </div>,
    document.body,
  );
}

export function Sidebar() {
  const s = useReader();
  // The roots added with ⌘⇧O are top folders of their own, named after their last segment.
  const roots = useMemo(() => rootDirs(s.session.roots, s.folder), [s.session.roots, s.folder]);
  // The path of each added file's own page (⌘⇧O on a .md, not a folder), so its row can offer
  // "Remove from session" directly — the only way to drop it when it has no root folder header
  // of its own (added from the session folder itself, or the lone file of a root folder elsewhere).
  const rootFilePaths = useMemo(() => {
    const set = new Set<string>();
    for (const r of s.session.roots ?? []) {
      if (r.file) set.add(r.folder === s.folder ? r.file : `${r.folder}/${r.file}`);
    }
    return set;
  }, [s.session.roots, s.folder]);
  const root = useMemo(() => buildFolders(s.pages, roots), [s.pages, roots]);
  const filterRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!s.ui.filterFocus) return;
    filterRef.current?.focus();
    filterRef.current?.select();
  }, [s.ui.filterFocus]);
  // Opening a page inside a closed folder opens the folder, so the current row is never hidden.
  useEffect(() => {
    if (s.session.current) store.revealInTree(s.session.current);
  }, [s.session.current]);
  // Esc clears the filter, then leaves the box.
  const onFilterKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    if (s.ui.filter) store.setFilter("");
    else e.currentTarget.blur();
  };
  const filter = s.ui.filter.trim().toLowerCase();
  // The two filter dots match the marks on the rows: unread (with pages still being written, or that
  // failed) and changes to review. A dot is only offered while some page carries its mark, and a filter
  // left on after its last page is gone is switched off, so the tree never sits empty behind it.
  const unreadMark = (path: string) => s.session.unread.includes(path) || s.session.loading.includes(path) || !!s.pageErrors[path];
  const changesMark = (path: string) => !!s.session.pending[path];
  const paths = Object.keys(s.pages);
  const anyUnread = paths.some(unreadMark);
  const anyChanges = paths.some(changesMark);
  const unreadOnly = s.ui.unreadOnly && anyUnread;
  const changesOnly = s.ui.changesOnly && anyChanges;
  useEffect(() => {
    if (s.ui.unreadOnly && !anyUnread) store.clearTreeFilter("unread");
    if (s.ui.changesOnly && !anyChanges) store.clearTreeFilter("changes");
  }, [s.ui.unreadOnly, s.ui.changesOnly, anyUnread, anyChanges]);
  // While filtering, every folder is open and one with nothing to show is left out.
  const filtering = !!filter || unreadOnly || changesOnly;
  const collapsed = s.session.collapsed ?? [];
  const shows = (it: TreeItem) => {
    const p = s.pages[it.path];
    if (!p) return false;
    if (filter && !p.title.toLowerCase().includes(filter) && !it.path.toLowerCase().includes(filter)) return false;
    // With both dots on, a page showing either mark is listed.
    if (unreadOnly || changesOnly) return (unreadOnly && unreadMark(it.path)) || (changesOnly && changesMark(it.path));
    return true;
  };
  // Dragging the right edge resizes the sidebar; the width is saved when the pointer is let go. Double-click resets it.
  const drag = useRef<{ x: number; width: number } | null>(null);
  const onGripDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, width: e.currentTarget.parentElement?.getBoundingClientRect().width ?? s.settings.sidebarWidth };
  };
  const onGripMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    store.previewSidebarWidth(drag.current.width + e.clientX - drag.current.x);
  };
  const onGripUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const width = drag.current.width + e.clientX - drag.current.x;
    drag.current = null;
    void store.setSidebarWidth(width);
  };
  const onRow = (path: string) => (e: MouseEvent) => {
    e.preventDefault();
    void store.openPage(path, store.placementFor(e));
  };
  // Each row has a ⋯ menu (also on right-click), and so does the header of an added root, keyed "root:<folder>".
  // A menu, the rename box it opens, and the delete confirmation all close on a click anywhere else,
  // Esc, or when the tree scrolls. The menu and confirmation sit in a body-level layer so a row
  // at the foot of a long tree still shows them in full, without scrolling the tree to reach them.
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  // The row that opened the menu or confirmation, so the body-level layer can sit against it.
  const [layerAnchor, setLayerAnchor] = useState<HTMLElement | null>(null);
  // The confirmation's checkbox, cleared each time it opens so a tick never carries over unseen.
  const [dontAsk, setDontAsk] = useState(false);
  // Right-clicking empty space in the tree (not a row or a root header, which have their own menus)
  // opens this instead, offering "Reload" and the same "Add to Session…" flow as ⌘⇧O.
  const [treeMenuAt, setTreeMenuAt] = useState<{ x: number; y: number } | null>(null);
  const closeMenus = () => {
    setMenuFor(null);
    setDeleting(null);
    setLayerAnchor(null);
    setTreeMenuAt(null);
  };
  useEffect(() => {
    if (!menuFor && !deleting && !treeMenuAt) return;
    const close = () => closeMenus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuFor, deleting, treeMenuAt]);
  const onTreeContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    setMenuFor(null);
    setDeleting(null);
    setLayerAnchor(null);
    setTreeMenuAt({ x: e.clientX, y: e.clientY });
  };
  // A row whose page has left the session (deleted here or elsewhere) takes its menu and boxes with it.
  useEffect(() => {
    const gone = (key: string | null) => !!key && (key.startsWith("root:") ? !roots.includes(key.slice(5)) : !s.pages[key]);
    if (gone(menuFor)) {
      setMenuFor(null);
      if (!deleting || gone(deleting)) setLayerAnchor(null);
    }
    if (gone(deleting)) {
      setDeleting(null);
      if (!menuFor || gone(menuFor)) setLayerAnchor(null);
    }
    if (gone(renaming)) setRenaming(null);
  }, [menuFor, deleting, renaming, s.pages, roots]);
  const openMenu = (path: string) => (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDeleting(null);
    if (menuFor === path) {
      setMenuFor(null);
      setLayerAnchor(null);
    } else {
      setMenuFor(path);
      setLayerAnchor((e.currentTarget as HTMLElement).closest(".row, .frow") as HTMLElement);
    }
  };
  // Delete asks from the row itself, until "Do not ask again" has been ticked once.
  const askDelete = (path: string) => {
    if (!s.settings.confirmDelete) {
      void store.deletePage(path);
      return;
    }
    setDontAsk(false);
    setDeleting(path);
  };
  const rows = (items: TreeItem[]) => {
    const visible = items.filter(shows);
    if (!visible.length) return null;
    return (
      <div className="rows">
        {visible.length > 1 && <div className="tree-line" />}
        {visible.map((it) => {
          const p = s.pages[it.path];
          const d = dotState(it.path, s.session);
          const cls = ["row", `d${Math.min(it.depth, 3)}`];
          if (d === "current") cls.push("current");
          const unread = s.session.unread.includes(it.path);
          const open = menuFor === it.path;
          const confirming = deleting === it.path;
          if (open || confirming) cls.push("open");
          const showTick = it.branch && !filtering;
          const isRootFile = rootFilePaths.has(it.path);
          // A page nested inside an added root, other than the root's own file, can be dropped on its own.
          const nestedInRoot = !isRootFile && roots.some((r) => it.path.startsWith(r + "/"));
          return (
            <div key={it.path} className={cls.join(" ")} onClick={onRow(it.path)} onContextMenu={openMenu(it.path)} title={p.title}>
              {showTick && <span className="tick" />}
              <span className={`dot ${d === "current" ? "current" : d === "loading" ? "loading" : ""}`} />
              {renaming === it.path ? (
                <RenameInput
                  value={p.title}
                  onDone={(name) => {
                    setRenaming(null);
                    if (name !== null) void store.renamePage(it.path, name);
                  }}
                />
              ) : (
                <span className={`label${d === "loading" ? " shimmer" : ""}`}>{p.title}</span>
              )}
              <span className="marks">
                {!!s.pageErrors[it.path] && <span className="fdot" title="Couldn't be written. Open it to try again." />}
                {unread && <span className="udot" title="Unread" />}
                {!!s.session.pending[it.path] && <span className="cdot" title="Changes to review" />}
              </span>
              <span className="more" title="More" onMouseDown={stop} onClick={openMenu(it.path)}>
                <MoreIcon />
              </span>
              {open && (
                <AnchoredLayer anchor={layerAnchor ?? undefined} className="row-menu">
                  <div
                    className="item"
                    onClick={() => {
                      setMenuFor(null);
                      store.toggleUnread(it.path);
                    }}
                  >
                    {unread ? "Mark read" : "Mark unread"}
                  </div>
                  <div className="sep" />
                  <div
                    className="item"
                    onClick={() => {
                      setMenuFor(null);
                      setRenaming(it.path);
                    }}
                  >
                    Rename
                  </div>
                  <div
                    className="item"
                    onClick={() => {
                      setMenuFor(null);
                      void store.revealPage(it.path);
                    }}
                  >
                    Reveal in Finder
                  </div>
                  {isRootFile && (
                    <div
                      className="item"
                      onClick={() => {
                        setMenuFor(null);
                        void store.removeRootFile(it.path);
                      }}
                    >
                      Remove from session
                    </div>
                  )}
                  {nestedInRoot && (
                    <div
                      className="item"
                      onClick={() => {
                        setMenuFor(null);
                        void store.excludeFromSession(it.path);
                      }}
                    >
                      Remove from session
                    </div>
                  )}
                  <div className="sep" />
                  <div
                    className="item warn"
                    onClick={() => {
                      setMenuFor(null);
                      askDelete(it.path);
                    }}
                  >
                    Delete
                  </div>
                </AnchoredLayer>
              )}
              {confirming && (
                <AnchoredLayer anchor={layerAnchor ?? undefined} className="row-confirm" stretch>
                  <div>Delete “{p.title}”?</div>
                  <div className="sub">
                    Its file moves to <code>.reader/trash</code> inside the folder.
                  </div>
                  <label className="again">
                    <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />
                    Do not ask again
                  </label>
                  <div className="acts">
                    <span className="c" onClick={() => setDeleting(null)}>
                      Cancel
                    </span>
                    <span
                      className="d"
                      onClick={() => {
                        setDeleting(null);
                        void store.deletePage(it.path, dontAsk);
                      }}
                    >
                      Delete
                    </span>
                  </div>
                </AnchoredLayer>
              )}
            </div>
          );
        })}
      </div>
    );
  };
  // A folder is its subfolders, then its own pages. Only the session folder itself has no header.
  const folder = (f: FolderNode): ReactNode => {
    const kids = f.folders.map(folder).filter(Boolean);
    const own = rows(f.items);
    if (!f.path)
      return (
        <>
          {kids}
          {own}
        </>
      );
    if (!kids.length && !own) return null;
    const open = filtering || !collapsed.includes(f.path);
    const menuKey = `root:${f.path}`;
    // The root folder of an added root drops the whole root; a folder nested inside one drops just its pages.
    const removable = f.root ? "root" : roots.some((r) => f.path.startsWith(r + "/")) ? "nested" : undefined;
    const menuOpen = !!removable && menuFor === menuKey;
    return (
      <div key={f.path} className={`folder${open ? " open" : ""}${f.root ? " root" : ""}`}>
        <div className={`frow${menuOpen ? " open" : ""}`} onClick={() => store.toggleFolder(f.path)} onContextMenu={removable ? openMenu(menuKey) : undefined} title={f.path}>
          <span className="chev">
            <ChevronRight />
          </span>
          <span className="label">{f.name}</span>
          {removable && (
            <span className="more" title="More" onMouseDown={stop} onClick={openMenu(menuKey)}>
              <MoreIcon />
            </span>
          )}
          {menuOpen && (
            <AnchoredLayer anchor={layerAnchor ?? undefined} className="row-menu">
              <div
                className="item"
                onClick={() => {
                  setMenuFor(null);
                  if (removable === "root") void store.removeRoot(f.path);
                  else void store.excludeFromSession(f.path);
                }}
              >
                Remove from session
              </div>
            </AnchoredLayer>
          )}
        </div>
        {open && (
          <div className="fbody">
            {kids}
            {own}
          </div>
        )}
      </div>
    );
  };
  return (
    <aside className="side">
      <div className="side-head">
        <span className="home-btn" title="Home ⌘⇧H" onClick={() => store.goHome()}>
          <ChevronLeft />
        </span>
        <span className="name" title={s.folderName}>
          {s.folderName || "Library"}
        </span>
        <span className="link" onClick={() => store.openMap("web")}>
          Map
        </span>
      </div>
      <div className="side-filter">
        <input
          ref={filterRef}
          placeholder="Filter"
          title="Filter files /"
          value={s.ui.filter}
          onChange={(e) => store.setFilter(e.target.value)}
          onKeyDown={onFilterKey}
          spellCheck={false}
        />
        {anyUnread && (
          <span className={`filter-btn${unreadOnly ? " on" : ""}`} title="Unread only" onClick={() => store.toggleUnreadOnly()}>
            <span className="udot" />
          </span>
        )}
        {anyChanges && (
          <span className={`filter-btn${changesOnly ? " on" : ""}`} title="Changes to review only" onClick={() => store.toggleChangesOnly()}>
            <span className="cdot" />
          </span>
        )}
      </div>
      <div className="tree" onScroll={() => (menuFor || deleting) && closeMenus()} onContextMenu={onTreeContextMenu}>
        <div className="tree-inner">{folder(root)}</div>
      </div>
      <PointMenu at={treeMenuAt}>
        <div
          className="item"
          onClick={() => {
            setTreeMenuAt(null);
            void store.reload();
          }}
        >
          Reload
        </div>
        <div className="sep" />
        <div
          className="item"
          onClick={() => {
            setTreeMenuAt(null);
            void store.addRoot();
          }}
        >
          Add to Session…
        </div>
      </PointMenu>
      <div className="side-foot">
        <span className={`link${s.ui.panePopover === "feedback" ? " on" : ""}`} onClick={() => store.toggleFeedback()} title="A bug, an idea, anything">
          Send feedback
        </span>
      </div>
      <div
        className="side-grip"
        title="Drag to resize"
        onPointerDown={onGripDown}
        onPointerMove={onGripMove}
        onPointerUp={onGripUp}
        onPointerCancel={onGripUp}
        onDoubleClick={() => void store.setSidebarWidth(DEFAULT_SETTINGS.sidebarWidth)}
      />
    </aside>
  );
}
