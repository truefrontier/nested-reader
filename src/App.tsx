import { useEffect, useState } from "react";
import { isTauri, platform } from "./platform";
import { store, useReader } from "./state/store";
import { Sidebar } from "./reader/Sidebar";
import { Home } from "./reader/Home";
import { Page } from "./reader/Page";
import { SplitPane } from "./reader/SplitPane";
import { MapOverlay } from "./reader/MapOverlay";
import { NewFilePopover, RefinePopover, RefineStatus } from "./reader/Popovers";
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
      const inInput = (e.target as HTMLElement)?.closest("input, textarea, [contenteditable]");
      if (e.key === "Escape") {
        store.escape();
        return;
      }
      // A bare / jumps to the tree's Filter box, as long as nothing is being typed.
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !inInput) {
        e.preventDefault();
        store.command("filter");
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
      // Find and filter have to work while typing in their boxes, so they stay in the webview like ⌘R.
      if (k === "f" && !e.shiftKey) {
        e.preventDefault();
        store.command("find");
        return;
      }
      if (k === "g") {
        e.preventDefault();
        store.command(e.shiftKey ? "find-prev" : "find-next");
        return;
      }
      if (e.key === "/") {
        e.preventDefault();
        store.command("filter");
        return;
      }
      // ⌘N works from inside the ask box too: it swaps that box for the new-page one.
      if (k === "n" && !e.shiftKey) {
        e.preventDefault();
        store.command("new-page");
        return;
      }
      if (menuHandled) return;
      if (k === "b") {
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
          <button className="tbtn side-toggle" title="Toggle tree ⌘B" onClick={() => store.toggleSidebar()}>
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
            {s.ui.panePopover === "new" && current && <NewFilePopover onSubmit={(text, verb, alt) => void store.newFile(text, verb, alt)} onEsc={() => store.closePopover()} />}
            {s.ui.panePopover === "refine" && current && (
              <RefinePopover
                pane
                initial={s.ui.refineText}
                onSubmit={(text, scope) => void store.refine(text, scope)}
                onEsc={() => store.closePopover()}
                onToggle={() => store.toggleRefine()}
              />
            )}
            {((s.ui.refining && s.ui.refining !== "selection") || (s.ui.refineError && s.ui.refineError.scope !== "selection")) && (
              <RefineStatus
                pane
                scope={s.ui.refineError?.scope ?? s.ui.refining ?? "page"}
                text={s.ui.refineText}
                error={s.ui.refineError?.message}
                onRetry={() => store.retryRefine()}
                onDismiss={() => store.closePopover()}
              />
            )}
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
