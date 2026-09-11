import { store, useReader } from "../state/store";
import { CloseIcon, FullscreenIcon, SyncScrollIcon } from "./Icons";
import { Page } from "./Page";

export function SplitPane() {
  const s = useReader();
  const path = s.session.split;
  if (!path || !s.pages[path]) return null;
  // The same page on both sides can scroll as one; the button shows only then, lit while the link is on.
  const samePage = s.session.current === path;
  const synced = samePage && s.ui.syncScroll;
  return (
    <div className="pane split">
      <div className="pane-tools">
        {samePage && (
          <button className={`tbtn${synced ? " on" : ""}`} title={synced ? "Stop scrolling together" : "Scroll together"} aria-pressed={synced} onClick={() => store.toggleSyncScroll()}>
            <SyncScrollIcon />
          </button>
        )}
        <button className="tbtn" title="Fullscreen ⌘⇧F" onClick={() => store.setUi({ fullscreen: !s.ui.fullscreen })}>
          <FullscreenIcon />
        </button>
        <button className="tbtn" title="Close" onClick={() => store.closeSplit()}>
          <CloseIcon />
        </button>
      </div>
      <Page path={path} role="split" />
    </div>
  );
}
