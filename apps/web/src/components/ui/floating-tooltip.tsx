"use client";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import styles from "./floating-tooltip.module.css";

type Placement = "top" | "bottom" | "right" | "left";

/** Anchor-relative point the tooltip should point at, before its own size is known. */
type TooltipAnchor = {
  text: string;
  anchorX: number;
  anchorY: number;
  placement: Placement;
};

/** Final on-screen box, computed once the tooltip's own size is measured. */
type TooltipBox = {
  left: number;
  top: number;
  /** Arrow offset along the box's main axis (px from the box's top-left). */
  arrowOffset: number;
};

const VIEWPORT_MARGIN = 8;
const ARROW_INSET = 10;

/** Not HTMLElement-only: chart bubbles/markers/quadrant labels carry `data-tooltip` on plain SVG
 * elements too, and SVGElement is a sibling of HTMLElement (not a subtype), so narrowing to
 * HTMLElement here would silently drop tooltips for every SVG-based chart. */
function resolveTarget(node: EventTarget | null): Element | null {
  if (!(node instanceof Element)) return null;
  const el = node.closest("[data-tooltip]");
  if (!el) return null;
  const text = el.getAttribute("data-tooltip")?.trim();
  if (!text) return null;
  return el;
}

function readPlacement(el: Element): Placement | "auto" {
  const attr = el.getAttribute("data-tooltip-placement");
  if (attr === "top" || attr === "bottom" || attr === "right" || attr === "left") {
    return attr;
  }
  return "auto";
}

function measureAnchor(el: Element): TooltipAnchor {
  const text = el.getAttribute("data-tooltip")!.trim();
  const rect = el.getBoundingClientRect();
  const gap = 8;
  const forced = readPlacement(el);

  if (forced === "right") {
    return { text, anchorX: rect.right + gap, anchorY: rect.top + rect.height / 2, placement: "right" };
  }

  if (forced === "left") {
    return { text, anchorX: rect.left - gap, anchorY: rect.top + rect.height / 2, placement: "left" };
  }

  const placement: Placement =
    forced === "top" || forced === "bottom"
      ? forced
      : rect.top < 36 + gap + 4
        ? "bottom"
        : "top";

  return {
    text,
    anchorX: rect.left + rect.width / 2,
    anchorY: placement === "top" ? rect.top - gap : rect.bottom + gap,
    placement,
  };
}

/** Clamp the box to stay fully on-screen, keeping the arrow aimed at the anchor point. */
function fitBox(
  anchor: TooltipAnchor,
  size: { width: number; height: number },
): TooltipBox {
  const { placement, anchorX, anchorY } = anchor;
  const { width, height } = size;
  const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN);
  const maxTop = Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN);

  if (placement === "top" || placement === "bottom") {
    const idealLeft = anchorX - width / 2;
    const left = Math.min(Math.max(idealLeft, VIEWPORT_MARGIN), maxLeft);
    const top =
      placement === "top"
        ? Math.max(anchorY - height, VIEWPORT_MARGIN)
        : Math.min(anchorY, maxTop);
    const arrowOffset = Math.min(
      Math.max(anchorX - left, ARROW_INSET),
      Math.max(width - ARROW_INSET, ARROW_INSET),
    );
    return { left, top, arrowOffset };
  }

  // left / right placements
  const idealTop = anchorY - height / 2;
  const top = Math.min(Math.max(idealTop, VIEWPORT_MARGIN), maxTop);
  const left =
    placement === "right"
      ? Math.min(anchorX, maxLeft)
      : Math.max(anchorX - width, VIEWPORT_MARGIN);
  const arrowOffset = Math.min(
    Math.max(anchorY - top, ARROW_INSET),
    Math.max(height - ARROW_INSET, ARROW_INSET),
  );
  return { left, top, arrowOffset };
}

export function FloatingTooltipHost() {
  const [anchor, setAnchor] = useState<TooltipAnchor | null>(null);
  const [box, setBox] = useState<TooltipBox | null>(null);
  const [mounted, setMounted] = useState(false);
  const tooltipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    let active: Element | null = null;
    let frame = 0;

    const hide = () => {
      active = null;
      setAnchor(null);
      setBox(null);
    };

    const show = (el: Element) => {
      active = el;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (active === el) setAnchor(measureAnchor(el));
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

  // Once the anchor (and its text) is known, measure the tooltip's actual
  // rendered size and clamp it to the viewport — the anchor rect alone
  // doesn't tell us how wide/tall the bubble will be, so a naive
  // center-on-anchor placement can run half off-screen for long text near
  // a screen edge (e.g. header controls hugging the right side).
  useLayoutEffect(() => {
    if (!anchor) return;
    const el = tooltipRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setBox(fitBox(anchor, { width, height }));
  }, [anchor]);

  if (!mounted || !anchor) return null;

  const placementClass =
    anchor.placement === "bottom"
      ? styles.bottom
      : anchor.placement === "right"
        ? styles.right
        : anchor.placement === "left"
          ? styles.left
          : styles.top;

  // Before the first measurement pass, render off-screen (still measurable)
  // rather than at a guessed position — avoids a visible jump/flash.
  const style: CSSProperties = box
    ? ({
        top: box.top,
        left: box.left,
        visibility: "visible",
        "--tooltip-arrow-offset": `${box.arrowOffset}px`,
      } as CSSProperties)
    : { top: -9999, left: -9999, visibility: "hidden" };

  return createPortal(
    <div
      ref={tooltipRef}
      className={`${styles.tooltip} ${placementClass}`}
      style={style}
      role="tooltip"
    >
      {anchor.text}
    </div>,
    document.body,
  );
}
