"use client";

import { useEffect, useRef } from "react";

export const UNSAVED_CHANGES_MESSAGE = "You have unsaved changes. Leave this page without saving?";

/**
 * Warns before leaving a page with unsaved changes: closing or reloading the tab (the browser's
 * own prompt), and following a link inside the app, which the App Router can't block, so the
 * click is checked before Next sees it. The browser's back button is not caught.
 */
export function useUnsavedChangesWarning(dirty: boolean, message = UNSAVED_CHANGES_MESSAGE): void {
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (!dirtyRef.current) return;
      e.preventDefault();
      // Older browsers show the prompt only when returnValue is set.
      e.returnValue = "";
    }

    function onClick(e: MouseEvent) {
      if (!dirtyRef.current || e.defaultPrevented || e.button !== 0) return;
      // Opening in a new tab or window doesn't leave this page.
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = (e.target as Element | null)?.closest?.("a[href]");
      if (!(link instanceof HTMLAnchorElement)) return;
      if (link.target && link.target !== "_self") return;
      if (link.hasAttribute("download")) return;
      const to = new URL(link.href, window.location.href);
      const here = window.location;
      // A link to a spot on this same page isn't leaving it.
      if (to.origin === here.origin && to.pathname === here.pathname && to.search === here.search)
        return;
      if (!window.confirm(message)) {
        e.preventDefault();
        e.stopPropagation();
      }
    }

    window.addEventListener("beforeunload", onBeforeUnload);
    // Capture phase, so the check runs before Next's Link handler starts the navigation.
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [message]);
}
