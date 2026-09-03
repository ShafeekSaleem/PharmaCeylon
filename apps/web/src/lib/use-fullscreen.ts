"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Wraps the browser Fullscreen API on `<html>` so it applies to the whole app,
 * not just one element. Windows desktop/till Chrome & Edge only — no vendor
 * prefixes, no iOS Safari fallback.
 */
export function useFullscreen() {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    function onChange() {
      setIsFullscreen(document.fullscreenElement !== null);
    }
    document.addEventListener("fullscreenchange", onChange);
    onChange();
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const enter = useCallback(() => {
    document.documentElement.requestFullscreen().catch(() => {});
  }, []);

  const exit = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }, []);

  const toggle = useCallback(() => {
    if (document.fullscreenElement) exit();
    else enter();
  }, [enter, exit]);

  return { isFullscreen, enter, exit, toggle };
}
