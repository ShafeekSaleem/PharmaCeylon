"use client";

import { useEffect } from "react";

/** Applied to <html> while overlays are open — pairs with scrollbar-gutter in globals.css */
export const SCROLL_LOCK_CLASS = "scroll-locked";

let lockCount = 0;

export function lockBodyScroll() {
  if (lockCount === 0) {
    document.documentElement.classList.add(SCROLL_LOCK_CLASS);
  }
  lockCount += 1;
}

export function unlockBodyScroll() {
  if (lockCount <= 0) return;
  lockCount -= 1;
  if (lockCount === 0) {
    document.documentElement.classList.remove(SCROLL_LOCK_CLASS);
  }
}
/** Prevents background scroll without layout shift when the scrollbar disappears. */
export function useBodyScrollLock(locked: boolean) {
  useEffect(() => {
    if (!locked) return;
    lockBodyScroll();
    return () => unlockBodyScroll();
  }, [locked]);
}
