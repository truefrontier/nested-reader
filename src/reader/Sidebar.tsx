import { useMemo, type MouseEvent } from "react";
import { store, useReader } from "../state/store";
import { buildTree, dotState } from "../lib/tree";

export function Sidebar() {
  const s = useReader();
  const items = useMemo(() => buildTree(s.pages), [s.pages]);
  const filter = s.ui.filter.trim().toLowerCase();
  const visible = items.filter((it) => {
    const p = s.pages[it.path];
    if (!p) return false;
    if (filter && !p.title.toLowerCase().includes(filter)) return false;
    if (s.ui.unreadOnly) {
      const d = dotState(it.path, s.session);
      return d === "unread" || d === "loading" || d === "pending";
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
        <span>{s.folderName || "Library"}</span>
        {s.folder && (
          <span className="link" onClick={() => store.openMap("web")}>
            Map
          </span>
        )}
      </div>
      <div className="side-filter">
        <input placeholder="Filter" value={s.ui.filter} onChange={(e) => store.setFilter(e.target.value)} spellCheck={false} />
        <span className={`unread-btn${s.ui.unreadOnly ? " on" : ""}`} title="Unread only" onClick={() => store.toggleUnreadOnly()}>
          <span className="gdot" />
        </span>
      </div>
      <div className="tree">
        {!s.folder && (
          <div className="side-empty">
            No folder open.
            <button onClick={() => void store.pickFolder()}>Choose a folder…</button>
          </div>
        )}
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
                {(d === "unread" || d === "pending" || !!s.session.pending[it.path]) && <span className="gdot" />}
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
