import { store, useReader } from "../state/store";
import { CloseIcon, FullscreenIcon } from "./Icons";
import { Page } from "./Page";

export function SplitPane() {
  const s = useReader();
  const path = s.session.split;
  if (!path || !s.pages[path]) return null;
  return (
    <div className="pane split">
      <div className="pane-tools">
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
