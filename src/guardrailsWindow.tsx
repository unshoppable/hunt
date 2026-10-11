// Renames stored entries of the former name harness before any store hydrates; must stay the first import.
import "./state/legacyStorage";
import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import { GuardrailsWindow } from "./guardrails/GuardrailsWindow";
import { parseWindowUrl } from "./ui/nativeWindow";

const { sessionId } = parseWindowUrl(window.location.search);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <GuardrailsWindow sessionId={sessionId} />
  </React.StrictMode>,
);
