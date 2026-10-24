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
