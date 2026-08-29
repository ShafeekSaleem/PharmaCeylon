"use client";

import { useEffect } from "react";
import { applyAppearancePrefs, readAppearancePrefs } from "@/lib/appearance";
import { useAuth } from "@/lib/use-auth";

/** Applies the viewer's saved Settings → Appearance preferences (accent color, font size,
 *  density) on mount. Mounted once in AppShell so it covers every authenticated page, not
 *  just the Appearance settings page itself. */
export function AppearanceEffect() {
  const { user } = useAuth();
  useEffect(() => {
    applyAppearancePrefs(readAppearancePrefs(user?.id));
  }, [user?.id]);
  return null;
}
