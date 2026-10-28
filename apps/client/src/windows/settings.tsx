import React from "react";
import ReactDOM from "react-dom/client";
import "../index.css";
import { SettingsWindow } from "../settings/SettingsWindow";
import { useAccountsSync, useSettingsSync } from "../app/window-bootstrap.hook";

function SettingsWindowRoot() {
  useSettingsSync();
  useAccountsSync();
  return <SettingsWindow />;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <SettingsWindowRoot />
  </React.StrictMode>,
);
