// Renames stored entries of the former name harness before any store hydrates; must stay the first import.
import "./state/legacyStorage";
import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import { EditorWindow } from "./ide/EditorWindow";
import { parseEditorWindowUrl } from "./ide/editorWindows";

const { sessionId, request } = parseEditorWindowUrl(window.location.search);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <EditorWindow sessionId={sessionId} initialRequest={request} />
  </React.StrictMode>,
);
