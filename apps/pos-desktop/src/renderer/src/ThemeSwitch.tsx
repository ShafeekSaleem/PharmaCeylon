import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import styles from "./Shell.module.css";

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** What the page is showing. An explicit data-theme (the screenshot fixture) wins; otherwise the
 *  media query, which main's nativeTheme.themeSource drives. */
function showingDark(): boolean {
  const stamped = document.documentElement.dataset.theme;
  if (stamped === "dark" || stamped === "light") return stamped === "dark";
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia(DARK_QUERY).matches
  );
}

/**
 * Sun/moon switch in the title bar (Epic UI1 #205). It flips what is showing and main remembers
 * the choice on this computer; the page and the Windows window buttons follow together because
 * both read nativeTheme. The icon shows where a click takes you: a moon on light, a sun on dark.
 *
 * The counter starts from the owner's default in the pharmacy brand. When the owner locks it, the
 * title bar leaves this switch out and main refuses a change anyway.
 */
export function ThemeSwitch() {
  const [dark, setDark] = useState(showingDark);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(DARK_QUERY);
    const sync = () => setDark(showingDark());
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  const label = dark ? "Switch to light theme" : "Switch to dark theme";

  return (
    <button
      type="button"
      className={styles.themeSwitch}
      aria-label={label}
      title={label}
      onClick={() => {
        const next = dark ? "light" : "dark";
        // Shown before main answers, so the click feels instant; the media query confirms it.
        setDark(!dark);
        void window.pos
          ?.setCounterTheme?.({ theme: next })
          // Locked since this was drawn: main kept the owner's theme, so show what is really there.
          .then((view) => {
            if (view.locked) setDark(showingDark());
          })
          .catch(() => setDark(showingDark()));
      }}
    >
      <Icon name={dark ? "sun" : "moon"} />
    </button>
  );
}
