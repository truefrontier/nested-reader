import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { store, useReader } from "../state/store";
import { buildFolders, dotState, type FolderNode, type TreeItem } from "../lib/tree";
import { ChevronLeft, ChevronRight, MoreIcon, PlusIcon } from "./Icons";
import { DEFAULT_SETTINGS } from "../platform";

export function Sidebar() {
  const s = useReader();
  const root = useMemo(() => buildFolders(s.pages), [s.pages]);
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
  // Each row has a ⋯ menu (also on right-click). It closes on a click anywhere else, Esc, or when the tree scrolls.
  const [menuFor, setMenuFor] = useState<string | null>(null);
  useEffect(() => {
    if (!menuFor) return;
    const close = () => setMenuFor(null);
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuFor]);
  useEffect(() => {
    if (menuFor && !s.pages[menuFor]) setMenuFor(null);
  }, [menuFor, s.pages]);
  const stop = (e: MouseEvent) => e.stopPropagation();
  const openMenu = (path: string) => (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuFor(menuFor === path ? null : path);
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
          if (open) cls.push("open");
          const showTick = it.branch && !filtering;
          return (
            <div key={it.path} className={cls.join(" ")} onClick={onRow(it.path)} onContextMenu={openMenu(it.path)} title={p.title}>
              {showTick && <span className="tick" />}
              <span className={`dot ${d === "current" ? "current" : d === "loading" ? "loading" : ""}`} />
              <span className={`label${d === "loading" ? " shimmer" : ""}`}>{p.title}</span>
              <span className="marks">
                {!!s.pageErrors[it.path] && <span className="fdot" title="Couldn't be written. Open it to try again." />}
                {unread && <span className="udot" title="Unread" />}
                {!!s.session.pending[it.path] && <span className="cdot" title="Changes to review" />}
              </span>
              <span className="more" title="More" onMouseDown={stop} onClick={openMenu(it.path)}>
                <MoreIcon />
              </span>
              {open && (
                <div className="row-menu" onMouseDown={stop} onClick={stop} onContextMenu={(e) => e.preventDefault()}>
                  <div
                    className="item"
                    onClick={() => {
                      setMenuFor(null);
                      store.toggleUnread(it.path);
                    }}
                  >
                    {unread ? "Mark read" : "Mark unread"}
                  </div>
                </div>
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
    return (
      <div key={f.path} className={`folder${open ? " open" : ""}`}>
        <div className="frow" onClick={() => store.toggleFolder(f.path)} title={f.path}>
          <span className="chev">
            <ChevronRight />
          </span>
          <span className="label">{f.name}</span>
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
      <div className="tree" onScroll={() => menuFor && setMenuFor(null)}>
        <div className="tree-inner">{folder(root)}</div>
      </div>
      <button className="home-new" onClick={() => store.toggleNewFile()} title="A new page written from this session">
        <PlusIcon />
        <span>New page</span>
        <span className="k">⌘N</span>
      </button>
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
