"use client";

import { useEffect, useState } from "react";
import { IconMoon, IconSun } from "@/components/icons";
import {
  APPEARANCE_CHANGED_EVENT,
  oppositeTheme,
  readAppearancePrefs,
  resolveIsDark,
  saveAppearancePrefs,
  watchSystemTheme,
} from "@/lib/appearance";
import { useAuth } from "@/lib/use-auth";
import styles from "./app-shell.module.css";

/**
 * Light/dark switch in the top bar on every page (Epic UI1 #205). It flips what is showing and
 * saves that as the person's choice; Settings › Appearance keeps "Match device" and the rest.
 * The icon shows where a click takes you: a moon on light, a sun on dark.
 */
export function ThemeToggle() {
  const { user } = useAuth();
  // null until mounted: the server can't know the theme, so render nothing that could mismatch.
  const [dark, setDark] = useState<boolean | null>(null);

  useEffect(() => {
    const sync = () =>
      setDark(resolveIsDark(readAppearancePrefs(user?.id).theme));
    sync();
    window.addEventListener(APPEARANCE_CHANGED_EVENT, sync);
    const stopWatching = watchSystemTheme(sync);
    return () => {
      window.removeEventListener(APPEARANCE_CHANGED_EVENT, sync);
      stopWatching();
    };
  }, [user?.id]);

  const label = dark ? "Switch to light theme" : "Switch to dark theme";

  return (
    <button
      type="button"
      className={styles.iconBtn}
      onClick={() => {
        const prefs = readAppearancePrefs(user?.id);
        saveAppearancePrefs(
          { ...prefs, theme: oppositeTheme(prefs.theme) },
          user?.id,
        );
      }}
      aria-label={label}
      data-tooltip={label}
      disabled={dark === null}
    >
      {dark ? <IconSun size={16} /> : <IconMoon size={16} />}
    </button>
  );
}
