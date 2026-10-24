import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import { DiffWindowHost } from "./graph/DiffWindow";
import { parseDiffWindowUrl } from "./graph/diffWindows";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <DiffWindowHost initialRequest={parseDiffWindowUrl(window.location.search)} />
  </React.StrictMode>,
);
