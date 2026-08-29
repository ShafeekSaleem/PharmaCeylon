"use client";

import { useEffect } from "react";
import { applyAppearancePrefs, readAppearancePrefs } from "@/lib/appearance";

/** Applies the viewer's saved Settings → Appearance preferences (accent color, font size,
 *  density) on mount. Mounted once in AppShell so it covers every authenticated page, not
 *  just the Appearance settings page itself. */
export function AppearanceEffect() {
  useEffect(() => {
    applyAppearancePrefs(readAppearancePrefs());
  }, []);
  return null;
}
