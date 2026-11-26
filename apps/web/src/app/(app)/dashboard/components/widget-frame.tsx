"use client";

import { Component, useEffect, useRef, type ReactNode } from "react";
import { IconGripVertical, IconX } from "@/components/icons";
import css from "../dashboard.module.css";

type BoundaryProps = { title: string; children: ReactNode };
type BoundaryState = { hasError: boolean };

/** Function components can't catch render errors — this keeps one widget's
 * crash from blanking the whole canvas. */
class WidgetErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { hasError: false };

  static getDerivedStateFromError(): BoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    // eslint-disable-next-line no-console
    console.error(`Dashboard widget "${this.props.title}" crashed:`, error);
  }

  render() {
    if (this.state.hasError) {
      return <p className={css.widgetErrorState}>Couldn&apos;t load &ldquo;{this.props.title}&rdquo;.</p>;
    }
    return this.props.children;
  }
}

type Props = {
  widgetKey: string;
  title: string;
  isEditing: boolean;
  onRemove: (key: string) => void;
  /** Called with the card's natural height in px whenever it changes, so the canvas can give it
   * exactly the rows it needs (UI1 #205). */
  onHeight?: (key: string, px: number) => void;
  children: ReactNode;
};

/** Additive edit-mode chrome around an existing widget body — in view mode
 * this renders no extra markup, so the canvas looks identical to today. The
 * `rgl-drag-handle` class is a plain (non-CSS-module) selector matched by
 * DashboardCanvas's `draggableHandle` prop. */
export function WidgetFrame({
  widgetKey,
  title,
  isEditing,
  onRemove,
  onHeight,
  children,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const report = useRef(onHeight);
  report.current = onHeight;

  // The frame is as tall as its content, never stretched to its grid cell, so what this
  // measures is the card's own height and the two can't feed each other.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => report.current?.(widgetKey, el.getBoundingClientRect().height);
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    return () => observer.disconnect();
  }, [widgetKey]);

  return (
    <div className={css.widgetFrame} ref={ref}>
      {isEditing ? (
        <div className={css.widgetFrameBar}>
          <span className={`${css.widgetDragHandle} rgl-drag-handle`}>
            <IconGripVertical size={14} strokeWidth={1.75} aria-hidden />
            {title}
          </span>
          <button
            type="button"
            className={css.widgetRemoveBtn}
            onClick={() => onRemove(widgetKey)}
            aria-label={`Remove ${title} widget`}
          >
            <IconX size={13} strokeWidth={2} />
          </button>
        </div>
      ) : null}
      <div className={css.widgetFrameBody}>
        <WidgetErrorBoundary title={title}>{children}</WidgetErrorBoundary>
      </div>
    </div>
  );
}
