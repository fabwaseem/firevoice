import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Spotlight } from "./Spotlight";
import "./spotlight.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Spotlight />
  </StrictMode>,
);
