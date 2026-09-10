"use client";

import { useEffect } from "react";
import {
  applyAppearancePrefs,
  readAppearancePrefs,
  watchSystemTheme,
} from "@/lib/appearance";
import { useAuth } from "@/lib/use-auth";

/** Applies the viewer's saved Settings → Appearance preferences (accent color, font size,
 *  density) on mount. Mounted once in AppShell so it covers every authenticated page, not
 *  just the Appearance settings page itself. */
export function AppearanceEffect() {
  const { user } = useAuth();
  useEffect(() => {
    const apply = () => applyAppearancePrefs(readAppearancePrefs(user?.id));
    apply();
    // Under "System" the accent has to be re-resolved when the OS flips, or the
    // page ends up on the dark ground with the light-mode teal still inlined.
    return watchSystemTheme(apply);
  }, [user?.id]);
  return null;
}
