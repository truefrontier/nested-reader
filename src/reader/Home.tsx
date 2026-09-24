import { useEffect, useState, type KeyboardEvent, type MouseEvent } from "react";
import { store, useReader } from "../state/store";
import { DEFAULT_SETTINGS, type RecentSession } from "../platform";
import { MoreIcon } from "./Icons";
import { RenameInput } from "./RenameInput";
import { FeedbackPopover } from "./Popovers";
import { useSidebarGrip } from "./useSidebarGrip";

const stop = (e: MouseEvent | KeyboardEvent) => e.stopPropagation();

function keyOf(r: RecentSession): string {
  return `${r.folder}\n${r.file ?? ""}`;
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
  const [settingDefault, setSettingDefault] = useState(false);
  // A quiet offer, shown until Not now or until Nested is the app. macOS may add its own confirmation.
  const offerDefault = s.settings.offerDefaultApp && s.defaultApp?.available === true && !s.defaultApp.isNested;
  const useNested = async () => {
    setSettingDefault(true);
    try {
      await store.makeDefaultApp();
    } finally {
      setSettingDefault(false);
    }
  };

  useEffect(() => {
    if (!menuFor) return;
    const close = () => setMenuFor(null);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menuFor]);

  const isCurrent = (r: RecentSession) => r.folder === s.folder && (r.file ?? "") === (s.rootFile ?? "");
  const { onGripDown, onGripMove, onGripUp } = useSidebarGrip(s.settings.sidebarWidth);

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
      <div className="home-main">
        <div className="home-start">
          <div className="home-title">Start a session</div>
          <div className="home-sub">A session grows from whatever you open. New pages are saved beside it as plain .md.</div>
          <div className="home-cards">
            <button className="home-card" onClick={() => void store.pickPath()}>
              <span className="t">
                <span>Open a folder or file…</span>
                <span className="k">⌘O</span>
              </span>
              <span className="d">A folder makes every .md inside the corpus. A single .md reads just that page, and pages you create are saved next to it.</span>
            </button>
          </div>
          <div className={`home-drop${s.ui.dragging ? " active" : ""}`}>or drop a folder or file anywhere in this window</div>
          {offerDefault && (
            <div className="home-offer">
              <span>
                Make Nested your app for .md files? A double‑click in Finder would open it here
                {s.defaultApp?.app ? `; today that opens ${s.defaultApp.app}.` : "."}
              </span>
              <span className="acts">
                <button disabled={settingDefault} onClick={() => void useNested()}>
                  {settingDefault ? "Waiting for macOS…" : "Use Nested"}
                </button>
                <button className="quiet" disabled={settingDefault} onClick={() => store.dismissDefaultAppOffer()}>
                  Not now
                </button>
              </span>
            </div>
          )}
        </div>
        {s.ui.panePopover === "feedback" && (
          <div className="pane-stack">
            <FeedbackPopover
              text={s.ui.feedbackMessage}
              email={s.ui.feedbackEmail}
              onChangeText={(v) => store.setFeedbackMessage(v)}
              onChangeEmail={(v) => store.setFeedbackEmail(v)}
              onSend={(message, email, attachment) => store.sendFeedback(message, email, attachment)}
              onEsc={() => store.closePopover()}
              subscribeAttachment={(h) => store.onFeedbackAttachment(h)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
