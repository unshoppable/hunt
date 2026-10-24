import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import { GuardrailsWindow } from "./guardrails/GuardrailsWindow";
import { parseWindowUrl } from "./ui/nativeWindow";

const { sessionId, params } = parseWindowUrl(window.location.search);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <GuardrailsWindow sessionId={sessionId} isWarm={params.has("warm")} />
  </React.StrictMode>,
);
