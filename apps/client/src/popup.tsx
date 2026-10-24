import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import { parsePopupWindowUrl } from "./popup/protocol";
import { PopupWindow } from "./popup/PopupWindow";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <PopupWindow kind={parsePopupWindowUrl(window.location.search)} />
  </React.StrictMode>,
);
