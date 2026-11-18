import { useEffect, useState } from "react";
import type { CounterBrand } from "../../shared/ipc-contract";

/**
 * The pharmacy brand on the counter screen (Epic UI1 #205). Main keeps the brand (fetched at
 * sign-in, cached on this computer) and builds the accent stylesheet; this draws it and reports
 * whether the owner has locked the theme, which hides the title-bar switch.
 *
 * It reads both every half minute: the calls are local and cheap, and an owner's change reaches
 * main at the next sign-in or within five minutes, so polling here adds no meaningful delay.
 */
const STYLE_ID = "pos-brand";
const POLL_MS = 30_000;

export function applyCounterBrand(brand: CounterBrand): void {
  const root = document.documentElement;
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (brand.css) {
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      document.head.appendChild(style);
    }
    if (style.textContent !== brand.css) style.textContent = brand.css;
  } else {
    style?.remove();
  }
  if (brand.statusSet === "colour-blind")
    root.dataset.statusSet = "colour-blind";
  else delete root.dataset.statusSet;
}

/** Draws the brand and returns whether the theme is locked. Mounted once, in the title bar. */
export function useCounterBrand(): { themeLocked: boolean } {
  const [themeLocked, setThemeLocked] = useState(false);

  useEffect(() => {
    let alive = true;
    const read = async () => {
      const pos = window.pos;
      if (!pos?.getCounterBrand || !pos.getCounterTheme) return;
      try {
        const [brand, theme] = await Promise.all([
          pos.getCounterBrand(),
          pos.getCounterTheme(),
        ]);
        if (!alive) return;
        applyCounterBrand(brand);
        setThemeLocked(theme.locked);
      } catch {
        // Main is starting or restarting: keep what is drawn and try again on the next tick.
      }
    };
    void read();
    const timer = window.setInterval(() => void read(), POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  return { themeLocked };
}
