import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { SettingsApp } from "./settings/SettingsApp";
import "./styles/app.css";
import "./styles/settings.css";

const params = new URLSearchParams(location.search);
const win = params.get("window") ?? (location.hash === "#settings" ? "settings" : null);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{win === "settings" ? <SettingsApp /> : <App />}</React.StrictMode>,
);
