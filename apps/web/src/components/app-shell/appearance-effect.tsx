"use client";

import { useEffect } from "react";
import {
  applyAppearancePrefs,
  readAppearancePrefs,
  watchSystemTheme,
} from "@/lib/appearance";
import {
  adoptPharmacyBrand,
  applyPharmacyBrand,
  fetchPharmacyBrand,
  readCachedBrand,
} from "@/lib/pharmacy-brand";
import { useAuth } from "@/lib/use-auth";

/** Applies the viewer's saved Settings → Appearance preferences (theme, font size, density) and
 *  the pharmacy brand on mount. Mounted once in AppShell so it covers every authenticated page, not
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

  // The pharmacy brand (UI1 #205): redraw the cached copy at once, then take the server's.
  useEffect(() => {
    if (!user?.id) return;
    const cached = readCachedBrand();
    if (cached) applyPharmacyBrand(cached);
    let live = true;
    fetchPharmacyBrand()
      .then((brand) => {
        if (live) adoptPharmacyBrand(brand);
      })
      .catch(() => {
        // Offline or signed out mid-request: keep the cached brand (or the defaults).
      });
    return () => {
      live = false;
    };
  }, [user?.id]);
  return null;
}
