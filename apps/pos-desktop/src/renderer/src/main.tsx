import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// The PMS design tokens (light + dark) and base styles, read from the web app
// itself so the two cannot drift. Becomes a packages/design-tokens import once
// the tokens are extracted.
import "../../../../web/src/app/globals.css";
import "./shell.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
