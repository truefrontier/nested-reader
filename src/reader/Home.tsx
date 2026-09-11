import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { store, useReader } from "../state/store";
import type { RecentSession } from "../platform";
import { MoreIcon, PlusIcon } from "./Icons";

const stop = (e: MouseEvent | KeyboardEvent) => e.stopPropagation();

function keyOf(r: RecentSession): string {
  return `${r.folder}\n${r.file ?? ""}`;
}

/** The label of a session row while it is being renamed. Enter keeps, Esc drops, blur keeps. */
function RenameInput({ value, onDone }: { value: string; onDone: (name: string | null) => void }) {
  const cancelled = useRef(false);
  return (
    <input
      className="rename"
      autoFocus
      defaultValue={value}
      spellCheck={false}
      onMouseDown={stop}
      onClick={stop}
      onFocus={(e) => e.target.select()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") e.currentTarget.blur();
        else if (e.key === "Escape") {
          cancelled.current = true;
          e.currentTarget.blur();
        }
      }}
      onBlur={(e) => onDone(cancelled.current ? null : e.target.value)}
    />
  );
}

/**
 * One level up from a session: recent sessions on the left, the ways to start
 * a new one on the right. Replaces the whole window; the open session stays
 * loaded so returning to it lands exactly where you left off.
 */
export function Home() {
  const s = useReader();
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  useEffect(() => {
    if (!menuFor) return;
    const close = () => setMenuFor(null);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menuFor]);

  const isCurrent = (r: RecentSession) => r.folder === s.folder && (r.file ?? "") === (s.rootFile ?? "");

  return (
    <div className="home">
      <aside className="home-side">
        <div className="home-head">Recent Sessions</div>
        <div className="home-list">
          {s.recents.length === 0 && <div className="home-empty">Sessions you open will be listed here.</div>}
          {s.recents.map((r) => {
            const k = keyOf(r);
            const current = isCurrent(r);
            const unread = current ? s.session.unread.length : r.unread;
            const open = menuFor === k;
            const cls = ["home-row"];
            if (current) cls.push("current");
            if (open) cls.push("open");
            return (
              <div key={k} className={cls.join(" ")} title={r.file ? `${r.folder}/${r.file}` : r.folder} onClick={() => void store.openRecent(r)}>
                {renaming === k ? (
                  <RenameInput
                    value={r.name}
                    onDone={(name) => {
                      setRenaming(null);
                      if (name !== null) void store.renameSession(r, name);
                    }}
                  />
                ) : (
                  <span className="label">{r.name}</span>
                )}
                {unread > 0 && <span className="udot" />}
                <span
                  className="more"
                  title="More"
                  onMouseDown={stop}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuFor(open ? null : k);
                  }}
                >
                  <MoreIcon />
                </span>
                {open && (
                  <div className="home-menu" onMouseDown={stop} onClick={stop}>
                    <div
                      className="item"
                      onClick={() => {
                        setMenuFor(null);
                        setRenaming(k);
                      }}
                    >
                      Rename
                    </div>
                    <div
                      className="item"
                      onClick={() => {
                        setMenuFor(null);
                        void store.revealSession(r);
                      }}
                    >
                      {r.file ? "Reveal file" : "Reveal folder"}
                    </div>
                    <div
                      className="item"
                      onClick={() => {
                        setMenuFor(null);
                        void store.mapSession(r);
                      }}
                    >
                      Map
                    </div>
                    <div className="sep" />
                    <div
                      className="item quiet"
                      onClick={() => {
                        setMenuFor(null);
                        store.removeRecent(r);
                      }}
                    >
                      Remove from recents
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <button className="home-new" onClick={() => void store.pickFolder()}>
          <PlusIcon />
          <span>New session</span>
          <span className="k">⌘O</span>
        </button>
      </aside>
      <div className="home-main">
        <div className="home-start">
          <div className="home-title">Start a session</div>
          <div className="home-sub">A session grows from whatever you open. New pages are saved beside it as plain .md.</div>
          <div className="home-cards">
            <button className="home-card" onClick={() => void store.pickFolder()}>
              <span className="t">
                <span>Open folder…</span>
                <span className="k">⌘O</span>
              </span>
              <span className="d">Every .md inside becomes the corpus. Best for a topic you've been collecting.</span>
            </button>
            <button className="home-card" onClick={() => void store.pickFile()}>
              <span className="t">
                <span>Open file…</span>
                <span className="k">⌘⇧O</span>
              </span>
              <span className="d">A single .md to read. Pages you create are saved next to it.</span>
            </button>
          </div>
          <div className={`home-drop${s.ui.dragging ? " active" : ""}`}>or drop a folder or file anywhere in this window</div>
        </div>
      </div>
    </div>
  );
}
