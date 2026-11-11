import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import "../../../../web/src/app/globals.css";
import "./tokens.css";
import "./shell.css";
import { ScreenshotShell } from "./ScreenshotShell";

function ThemeFromQuery() {
  useEffect(() => {
    const theme = new URLSearchParams(window.location.search).get("theme");
    if (theme === "light" || theme === "dark")
      document.documentElement.dataset.theme = theme;
  }, []);
  return null;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeFromQuery />
    <ScreenshotShell />
  </StrictMode>,
);
