"use client";

import { useEffect, useState } from "react";

/**
 * Page elements the floating "New Sale" button must never cover.
 *
 * Modals don't need this — they sit at z-index 100+, well above the FAB. This is for action
 * rows that live in the page itself, where a right-aligned "Save" or "Continue" lands in
 * exactly the corner the FAB occupies. Mark such a row with `data-fab-avoid` and the FAB gets
 * out of its way while it is on screen.
 */
const AVOID_SELECTOR = "[data-fab-avoid]";

/** Hide a little before the boxes actually touch, so the FAB is never visually crowding a button. */
const CLEARANCE_PX = 12;

function overlaps(a: DOMRect, b: DOMRect): boolean {
  return (
    a.left < b.right + CLEARANCE_PX &&
    a.right > b.left - CLEARANCE_PX &&
    a.top < b.bottom + CLEARANCE_PX &&
    a.bottom > b.top - CLEARANCE_PX
  );
}

/**
 * True while the FAB is sitting on top of a page action row.
 *
 * The FAB stays in the DOM when this is true — it is only made invisible and inert — because
 * measuring its rect is how the overlap is detected. Unmounting it would free the rect, which
 * would clear the overlap, which would remount it: a flicker loop.
 */
export function useFabClearance(enabled: boolean): boolean {
  const [obstructed, setObstructed] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setObstructed(false);
      return;
    }

    let frame = 0;

    const measure = () => {
      frame = 0;
      const fab = document.querySelector<HTMLElement>("[data-fab]");
      if (!fab) return;
      const fabRect = fab.getBoundingClientRect();
      if (fabRect.width === 0 && fabRect.height === 0) return;

      const viewportH = window.innerHeight;
      const viewportW = window.innerWidth;
      let hit = false;
      for (const el of document.querySelectorAll<HTMLElement>(AVOID_SELECTOR)) {
        const rect = el.getBoundingClientRect();
        // Off-screen rows can't be in the way, and skipping them keeps this cheap on long pages.
        if (rect.bottom < 0 || rect.top > viewportH) continue;
        if (rect.right < 0 || rect.left > viewportW) continue;
        if (overlaps(fabRect, rect)) {
          hit = true;
          break;
        }
      }
      setObstructed(hit);
    };

    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(measure);
    };

    schedule();
    // Capture phase so scrolling inside a panel counts, not just the window.
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule, { passive: true });

    // Wizards swap their action row between steps, so the marked elements change without a
    // scroll or resize ever firing.
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
      observer.disconnect();
    };
  }, [enabled]);

  return obstructed;
}
