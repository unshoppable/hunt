import React from "react";
import ReactDOM from "react-dom/client";
import "../index.css";
import { EditorWindow } from "../ide/EditorWindow";
import { parseEditorWindowUrl } from "../ide/editor-window.utils";
import { useBackendEvents, usePaneStyles, useSettingsSync } from "../app/window-bootstrap.hook";

const { sessionId, request } = parseEditorWindowUrl(window.location.search);

function EditorWindowRoot() {
  usePaneStyles();
  useSettingsSync();
  useBackendEvents();
  return <EditorWindow sessionId={sessionId} initialRequest={request} />;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <EditorWindowRoot />
  </React.StrictMode>,
);
