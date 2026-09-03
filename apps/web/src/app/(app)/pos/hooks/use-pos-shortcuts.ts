"use client";

import { useEffect, useRef } from "react";

export type PosShortcutHandlers = {
  focusSearch: () => void;
  priceCheck: () => void;
  completeSale: () => void;
  holdSale: () => void;
  recallSale: () => void;
  newSale: () => void;
  cyclePayment: () => void;
  customerLookup: () => void;
  linkPrescription: () => void;
  clearCart: () => void;
  toggleShortcuts: () => void;
  toggleFocusMode: () => void;
  escape: () => void;
};

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

/**
 * Counter keyboard map. Function keys and Alt combos always fire (a cashier's
 * hands live in the barcode field), while plain `?` is ignored while typing.
 */
export function usePosShortcuts(handlers: PosShortcutHandlers, enabled = true) {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    if (!enabled) return;

    function onKeyDown(event: KeyboardEvent) {
      const h = ref.current;

      switch (event.key) {
        case "F3":
          event.preventDefault();
          h.priceCheck();
          return;
        case "F4":
          event.preventDefault();
          h.completeSale();
          return;
        case "F6":
          event.preventDefault();
          h.holdSale();
          return;
        case "F7":
          event.preventDefault();
          h.recallSale();
          return;
        case "F8":
          event.preventDefault();
          h.newSale();
          return;
        case "F9":
          event.preventDefault();
          h.cyclePayment();
          return;
        case "Escape":
          h.escape();
          return;
        default:
          break;
      }

      // `/` replaces F2 for search focus. Allow a literal slash only in notes/free text.
      if (event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const target = event.target;
        const allowSlash =
          target instanceof HTMLTextAreaElement ||
          (target instanceof HTMLElement && target.isContentEditable);
        if (!allowSlash) {
          event.preventDefault();
          h.focusSearch();
          return;
        }
      }

      if (event.altKey && !event.ctrlKey && !event.metaKey) {
        const code = event.code;
        if (code === "KeyC") {
          event.preventDefault();
          h.customerLookup();
          return;
        }
        if (code === "KeyR") {
          event.preventDefault();
          h.linkPrescription();
          return;
        }
        if (code === "KeyX") {
          event.preventDefault();
          h.clearCart();
          return;
        }
        if (code === "KeyF") {
          event.preventDefault();
          h.toggleFocusMode();
          return;
        }
      }

      if (event.key === "?" && !isTypingTarget(event.target)) {
        event.preventDefault();
        h.toggleShortcuts();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}
