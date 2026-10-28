import React from "react";
import ReactDOM from "react-dom/client";
import "../index.css";
import { parsePopupWindowUrl } from "../ui/popup-protocol.utils";
import { PopupWindow } from "../popup/PopupWindow";
import { useBackendEvents, usePaneStyles, useSettingsSync } from "../app/window-bootstrap.hook";

const kind = parsePopupWindowUrl(window.location.search);

function PopupWindowRoot() {
  usePaneStyles();
  useSettingsSync();
  useBackendEvents();
  return <PopupWindow kind={kind} />;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <PopupWindowRoot />
  </React.StrictMode>,
);
