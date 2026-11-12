import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { applyTheme, useSettings } from "./stores/settings";
import "./styles/globals.css";
import { isMac } from "./lib/platform";

// the system, for the few styles that differ (macOS: room for its own window buttons)
document.documentElement.dataset.os = isMac ? "mac" : "other";

applyTheme(useSettings.getState().theme);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
