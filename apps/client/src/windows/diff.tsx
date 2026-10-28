import React from "react";
import ReactDOM from "react-dom/client";
import "../index.css";
import { DiffWindowHost } from "../diff/DiffWindow";
import { parseDiffWindowUrl } from "../diff/diff-window.utils";
import { useBackendEvents, usePaneStyles, useSettingsSync } from "../app/window-bootstrap.hook";

const initialRequest = parseDiffWindowUrl(window.location.search);

function DiffWindowRoot() {
  usePaneStyles();
  useSettingsSync();
  useBackendEvents();
  return <DiffWindowHost initialRequest={initialRequest} />;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <DiffWindowRoot />
  </React.StrictMode>,
);
