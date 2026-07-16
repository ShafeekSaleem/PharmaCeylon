"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./floating-tooltip.module.css";

type TooltipState = {
  text: string;
  top: number;
  left: number;
  placement: "top" | "bottom";
};

function resolveTarget(node: EventTarget | null): HTMLElement | null {
  if (!(node instanceof Element)) return null;
  const el = node.closest("[data-tooltip]");
  if (!(el instanceof HTMLElement)) return null;
  const text = el.getAttribute("data-tooltip")?.trim();
  if (!text) return null;
  return el;
}

function measure(el: HTMLElement): TooltipState {
  const text = el.getAttribute("data-tooltip")!.trim();
  const rect = el.getBoundingClientRect();
  const gap = 8;
  const estimatedHeight = 36;
  const spaceAbove = rect.top;
  const placement: "top" | "bottom" =
    spaceAbove < estimatedHeight + gap + 4 ? "bottom" : "top";

  const top =
    placement === "top" ? rect.top - gap : rect.bottom + gap;
  const left = Math.min(
    Math.max(rect.left + rect.width / 2, 12),
    window.innerWidth - 12,
  );

  return { text, top, left, placement };
}

export function FloatingTooltipHost() {
  const [state, setState] = useState<TooltipState | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    let active: HTMLElement | null = null;
    let frame = 0;

    const hide = () => {
      active = null;
      setState(null);
    };

    const show = (el: HTMLElement) => {
      active = el;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (active === el) setState(measure(el));
      });
    };

    const onPointerOver = (event: Event) => {
      const el = resolveTarget(event.target);
      if (!el) return;
      show(el);
    };

    const onPointerOut = (event: Event) => {
      const el = resolveTarget(event.target);
      if (!el || el !== active) return;
      const next = (event as PointerEvent).relatedTarget;
      if (next instanceof Node && el.contains(next)) return;
      hide();
    };

    const onFocusIn = (event: FocusEvent) => {
      const el = resolveTarget(event.target);
      if (el) show(el);
    };

    const onFocusOut = (event: FocusEvent) => {
      const el = resolveTarget(event.target);
      if (!el || el !== active) return;
      hide();
    };

    const onScrollOrResize = () => {
      if (!active) return;
      if (!document.body.contains(active)) {
        hide();
        return;
      }
      show(active);
    };

    document.addEventListener("pointerover", onPointerOver, true);
    document.addEventListener("pointerout", onPointerOut, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);

    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerover", onPointerOver, true);
      document.removeEventListener("pointerout", onPointerOut, true);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", onFocusOut, true);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, []);

  if (!mounted || !state) return null;

  return createPortal(
    <div
      className={`${styles.tooltip} ${
        state.placement === "bottom" ? styles.bottom : styles.top
      }`}
      style={{ top: state.top, left: state.left }}
      role="tooltip"
    >
      {state.text}
    </div>,
    document.body,
  );
}
