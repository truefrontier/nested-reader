import { store, useReader } from "../state/store";
import { CloseIcon, FullscreenIcon, SyncScrollIcon } from "./Icons";
import { Page } from "./Page";
import { PageMenu } from "./PageMenu";
import { useSplitGrip } from "./useSplitGrip";

export function SplitPane() {
  const s = useReader();
  const dir = s.session.splitDirection;
  const { gripProps } = useSplitGrip(dir, s.settings.splitShare?.[dir]);
  const path = s.session.split;
  if (!path || !s.pages[path]) return null;
  // The same page on both sides can scroll as one; the button shows only then, lit while the link is on.
  const samePage = s.session.current === path;
  const synced = samePage && s.ui.syncScroll;
  return (
    <>
      {/* ⌘⇧F hides the main pane, so there is no edge to drag. */}
      {!s.ui.fullscreen && (
        <div className="split-grip" title="Drag to resize" {...gripProps} />
      )}
      <div className="pane split">
        <div className="pane-tools">
          <PageMenu path={path} />
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
    </>
  );
}
