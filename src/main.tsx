import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { SettingsApp } from "./settings/SettingsApp";
import "./styles/app.css";
import "./styles/settings.css";

// Text boxes show their focus ring only while the keyboard is driving (app.css, html[data-kb]): Tab, or a
// key pressed outside a text box (/ to the filter, ⌘F to find). Typing inside a box, and the mouse, don't count.
const root = document.documentElement;
window.addEventListener(
  "keydown",
  (e) => {
    if (e.key === "Tab" || !(e.target as Element | null)?.closest?.("input, textarea, [contenteditable]")) root.dataset.kb = "";
  },
  true,
);
window.addEventListener("pointerdown", () => delete root.dataset.kb, true);

const params = new URLSearchParams(location.search);
const win = params.get("window") ?? (location.hash === "#settings" ? "settings" : null);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{win === "settings" ? <SettingsApp /> : <App />}</React.StrictMode>,
);
