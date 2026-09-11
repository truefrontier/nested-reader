import { useEffect, useMemo, useRef, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { store, useReader } from "../state/store";
import { buildFolders, dotState, type FolderNode, type TreeItem } from "../lib/tree";
import { ChevronLeft, ChevronRight, PlusIcon } from "./Icons";
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
  // While filtering, every folder is open and one with nothing to show is left out.
  const filtering = !!filter || s.ui.unreadOnly;
  const collapsed = s.session.collapsed ?? [];
  const shows = (it: TreeItem) => {
    const p = s.pages[it.path];
    if (!p) return false;
    if (filter && !p.title.toLowerCase().includes(filter) && !it.path.toLowerCase().includes(filter)) return false;
    if (s.ui.unreadOnly) {
      const d = dotState(it.path, s.session);
      return d === "unread" || d === "loading" || d === "pending" || !!s.pageErrors[it.path];
    }
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
          const showTick = it.branch && !filtering;
          return (
            <div key={it.path} className={cls.join(" ")} onClick={onRow(it.path)} title={p.title}>
              {showTick && <span className="tick" />}
              <span className={`dot ${d === "current" ? "current" : d === "loading" ? "loading" : ""}`} />
              <span className={`label${d === "loading" ? " shimmer" : ""}`}>{p.title}</span>
              <span className="marks">
                {!!s.pageErrors[it.path] && <span className="fdot" title="Couldn't be written. Open it to try again." />}
                {s.session.unread.includes(it.path) && <span className="udot" title="Unread" />}
                {!!s.session.pending[it.path] && <span className="cdot" title="Changes to review" />}
              </span>
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
        <span className={`unread-btn${s.ui.unreadOnly ? " on" : ""}`} title="Unread only" onClick={() => store.toggleUnreadOnly()}>
          <span className="udot" />
        </span>
      </div>
      <div className="tree">
        <div className="tree-inner">{folder(root)}</div>
      </div>
      <button className="home-new" onClick={() => store.toggleNewFile()} title="A new page written from this session">
        <PlusIcon />
        <span>New page</span>
        <span className="k">⌘N</span>
      </button>
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
