import { useEffect, useState } from "react";
import { isTauri, platform } from "./platform";
import { store, useReader } from "./state/store";
import { Sidebar } from "./reader/Sidebar";
import { Home } from "./reader/Home";
import { Page } from "./reader/Page";
import { SplitPane } from "./reader/SplitPane";
import { MapOverlay } from "./reader/MapOverlay";
import { RefinePopover } from "./reader/Popovers";
import { SidebarIcon } from "./reader/Icons";
import { SettingsApp } from "./settings/SettingsApp";

export default function App() {
  const s = useReader();
  const [mockSettings, setMockSettings] = useState(false);

  useEffect(() => {
    void store.init();
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onScheme = () => store.applyTheme(store.state.settings);
    mq.addEventListener("change", onScheme);
    const onOpenSettings = () => setMockSettings(true);
    window.addEventListener("ml:open-settings", onOpenSettings);
    return () => {
      mq.removeEventListener("change", onScheme);
      window.removeEventListener("ml:open-settings", onOpenSettings);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inInput = (e.target as HTMLElement)?.closest("input, textarea");
      if (e.key === "Escape") {
        store.escape();
        return;
      }
      if (!e.metaKey) return;
      const menuHandled = isTauri;
      const k = e.key.toLowerCase();
      if (k === "r" && !inInput) {
        e.preventDefault();
        store.command("refine");
        return;
      }
      if (menuHandled) return;
      if (e.key === "\\") {
        e.preventDefault();
        store.command("toggle-sidebar");
      } else if (k === "k") {
        e.preventDefault();
        store.command("map");
      } else if (k === "f" && e.shiftKey) {
        e.preventDefault();
        store.command("fullscreen-pane");
      } else if (e.key === "[") {
        e.preventDefault();
        store.command("back");
      } else if (e.key === "]") {
        e.preventDefault();
        store.command("forward");
      } else if (k === "o" && e.shiftKey) {
        e.preventDefault();
        store.command("open-file");
      } else if (k === "o") {
        e.preventDefault();
        store.command("open-folder");
      } else if (k === "h" && e.shiftKey) {
        e.preventDefault();
        store.command("home");
      } else if (e.key === ",") {
        e.preventDefault();
        void platform.openSettings();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const current = s.session.current;
  const split = s.session.split;
  const showMainPane = !(s.ui.fullscreen && split);
  // Home replaces the whole window: on request, and whenever nothing is open.
  const showHome = s.home || (s.ready && !s.folder);

  return (
    <div className="app">
      {!isTauri && (
        <div className="tl">
          <span style={{ background: "#ff5f57" }} />
          <span style={{ background: "#febc2e" }} />
          <span style={{ background: "#28c840" }} />
        </div>
      )}
      {isTauri && <div className="titlebar" data-tauri-drag-region />}
      {showHome ? (
        <Home />
      ) : (
        <>
          <button className="tbtn side-toggle" title="Toggle tree ⌘\" onClick={() => store.toggleSidebar()}>
            <SidebarIcon />
          </button>
          {s.session.sidebar && <Sidebar />}
          <div className={`main ${s.session.splitDirection}`}>
            {current && s.pages[current] ? (
              <div className={`pane${showMainPane ? "" : " hidden"}`}>
                <Page path={current} role="main" />
              </div>
            ) : (
              s.ready && (
                <div className="empty-state">
                  <div>
                    This folder has no Markdown pages yet.
                    <button onClick={() => store.goHome()}>Home</button>
                  </div>
                </div>
              )
            )}
            {split && <SplitPane />}
            {s.ui.panePopover && current && (
              <RefinePopover pane onSubmit={(text, scope) => void store.refine(text, scope)} onEsc={() => store.closePopover()} onToggle={() => store.toggleRefine()} />
            )}
            {s.ui.refining && <div className="busy">Refining {s.ui.refining === "corpus" ? "corpus" : s.ui.refining}…</div>}
            {s.ui.map && <MapOverlay />}
          </div>
        </>
      )}
      {s.ui.error && <div className="toast">{s.ui.error}</div>}
      {mockSettings && (
        <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && setMockSettings(false)}>
          <SettingsApp embedded onClose={() => setMockSettings(false)} />
        </div>
      )}
    </div>
  );
}
