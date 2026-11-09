import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { store, useReader } from "../state/store";
import { DEFAULT_SETTINGS, type RecentSession } from "../platform";
import { MoreIcon } from "./Icons";
import { RenameInput } from "./RenameInput";
import { FeedbackPopover } from "./Popovers";
import { useSidebarGrip } from "./useSidebarGrip";
import { onEscapeFirst } from "../lib/escapeFirst";
import { moveFocus, PRESS } from "../lib/keys";

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

  // The ⋯ that opened a menu from the keyboard (Enter or Space on it), which takes the focus back after.
  const returnTo = useRef<HTMLElement | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeMenu = () => {
    setMenuFor(null);
    const el = returnTo.current;
    returnTo.current = null;
    // "Remove from recents" takes the row, and its ⋯, with it: the first session's name takes the focus then.
    if (el) requestAnimationFrame(() => (el.isConnected ? el : document.querySelector<HTMLElement>(".home-row .label"))?.focus());
  };
  useEffect(() => {
    if (!menuFor) return;
    const close = () => {
      returnTo.current = null;
      setMenuFor(null);
    };
    window.addEventListener("mousedown", close);
    const stopEscape = onEscapeFirst(window, closeMenu);
    if (returnTo.current) menuRef.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    return () => {
      window.removeEventListener("mousedown", close);
      stopEscape();
    };
  }, [menuFor]);
  const onMenuKey = (e: KeyboardEvent) => {
    if (!e.metaKey) e.stopPropagation();
    if (e.key === "Tab") {
      e.preventDefault();
      closeMenu();
    } else if (moveFocus(e.currentTarget, "[role=menuitem]", e.key)) e.preventDefault();
  };
  const pick = (run: () => void) => () => {
    closeMenu();
    run();
  };

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
                    label="Session name"
                    onDone={(name) => {
                      setRenaming(null);
                      if (name !== null) void store.renameSession(r, name);
                      closeMenu();
                    }}
                  />
                ) : (
                  // The name is the row's button for the keyboard; a click anywhere on the row still opens it.
                  <span className="label" {...PRESS} aria-current={current || undefined}>
                    {r.name}
                  </span>
                )}
                {unread > 0 && <span className="udot" role="img" aria-label="Unread" />}
                <span
                  className="more"
                  {...PRESS}
                  aria-label={`More for ${r.name}`}
                  aria-haspopup="menu"
                  aria-expanded={open}
                  title="More"
                  onMouseDown={stop}
                  onClick={(e) => {
                    e.stopPropagation();
                    // A press from Enter or Space has no mouse clicks behind it.
                    returnTo.current = !open && e.detail === 0 ? e.currentTarget : null;
                    setMenuFor(open ? null : k);
                  }}
                >
                  <MoreIcon />
                </span>
                {open && (
                  <div className="home-menu" ref={menuRef} role="menu" aria-label={`Session “${r.name}”`} onMouseDown={stop} onClick={stop} onKeyDown={onMenuKey}>
                    <button
                      type="button"
                      role="menuitem"
                      tabIndex={-1}
                      className="item"
                      onClick={() => {
                        setMenuFor(null);
                        setRenaming(k);
                      }}
                    >
                      Rename
                    </button>
                    <button type="button" role="menuitem" tabIndex={-1} className="item" onClick={pick(() => void store.revealSession(r))}>
                      {r.file ? "Reveal file" : "Reveal folder"}
                    </button>
                    <button type="button" role="menuitem" tabIndex={-1} className="item" onClick={pick(() => void store.mapSession(r))}>
                      Map
                    </button>
                    <div className="sep" role="separator" />
                    <button type="button" role="menuitem" tabIndex={-1} className="item quiet" onClick={pick(() => store.removeRecent(r))}>
                      Remove from recents
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="side-foot">
          <span className={`link${s.ui.panePopover === "feedback" ? " on" : ""}`} {...PRESS} aria-expanded={s.ui.panePopover === "feedback"} onClick={() => store.toggleFeedback()} title="A bug, an idea, anything">
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
      <main className="home-main">
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
      </main>
    </div>
  );
}
