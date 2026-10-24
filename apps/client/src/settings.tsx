import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import { SettingsWindow } from "./settings/SettingsWindow";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <SettingsWindow />
  </React.StrictMode>,
);
