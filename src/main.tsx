import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./i18n";
import "@xterm/xterm/css/xterm.css";
import "./styles/globals.css";

// Disable the native WebView2 context menu globally.
// Radix ContextMenu components still work — they capture the event on their
// trigger elements before it reaches this document-level handler.
document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
