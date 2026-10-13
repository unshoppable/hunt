// Renames stored entries of the former name harness before any store hydrates; must stay the first import.
import "./state/legacyStorage";
import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import { SettingsWindow } from "./settings/SettingsWindow";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <SettingsWindow />
  </React.StrictMode>,
);
