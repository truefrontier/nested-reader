import { useEffect, useMemo, useRef, type KeyboardEvent, type MouseEvent } from "react";
import { store, useReader } from "../state/store";
import { buildTree, dotState } from "../lib/tree";
import { ChevronLeft, PlusIcon } from "./Icons";

export function Sidebar() {
  const s = useReader();
  const items = useMemo(() => buildTree(s.pages), [s.pages]);
  const filterRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!s.ui.filterFocus) return;
    filterRef.current?.focus();
    filterRef.current?.select();
  }, [s.ui.filterFocus]);
  // Esc clears the filter, then leaves the box.
  const onFilterKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    if (s.ui.filter) store.setFilter("");
    else e.currentTarget.blur();
  };
  const filter = s.ui.filter.trim().toLowerCase();
  const visible = items.filter((it) => {
    const p = s.pages[it.path];
    if (!p) return false;
    if (filter && !p.title.toLowerCase().includes(filter)) return false;
    if (s.ui.unreadOnly) {
      const d = dotState(it.path, s.session);
      return d === "unread" || d === "loading" || d === "pending" || !!s.pageErrors[it.path];
    }
    return true;
  });
  const onRow = (path: string) => (e: MouseEvent) => {
    e.preventDefault();
    void store.openPage(path, store.placementFor(e));
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
        <div className="tree-inner">
          {visible.length > 1 && <div className="tree-line" />}
          {visible.map((it) => {
            const p = s.pages[it.path];
            const d = dotState(it.path, s.session);
            const cls = ["row", `d${Math.min(it.depth, 3)}`];
            if (d === "current") cls.push("current");
            const showTick = it.branch && !s.ui.unreadOnly && !filter;
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
      </div>
      <button className="home-new" onClick={() => store.toggleNewFile()} title="A new page written from this session">
        <PlusIcon />
        <span>New page</span>
        <span className="k">⌘N</span>
      </button>
    </aside>
  );
}
