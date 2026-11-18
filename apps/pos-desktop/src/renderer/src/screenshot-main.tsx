import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import "../../../../web/src/app/globals.css";
import "./tokens.css";
import "./shell.css";
import { App } from "./App";
import { ScreenshotShell } from "./ScreenshotShell";
import { installReconnectFixture, reconnectShot } from "./ScreenshotReconnect";

// P4 #50, slice 4c: the real App on fixture answers (`?reconnect=drain`, …).
const reconnect = reconnectShot(window.location.search);
if (reconnect) installReconnectFixture(reconnect);

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
    {reconnect ? <App /> : <ScreenshotShell />}
  </StrictMode>,
);
