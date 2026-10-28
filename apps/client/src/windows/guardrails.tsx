import React from "react";
import ReactDOM from "react-dom/client";
import "../index.css";
import { GuardrailsWindow } from "../guardrails/GuardrailsWindow";
import { parseWindowUrl } from "../ui/native-window.utils";
import { useBackendEvents, usePaneStyles, useSettingsSync } from "../app/window-bootstrap.hook";

const { sessionId, params } = parseWindowUrl(window.location.search);

function GuardrailsWindowRoot() {
  usePaneStyles();
  useSettingsSync();
  useBackendEvents();
  return <GuardrailsWindow sessionId={sessionId} isWarm={params.has("warm")} />;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <GuardrailsWindowRoot />
  </React.StrictMode>,
);
