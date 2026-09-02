"use client";

import { Component, type ReactNode } from "react";
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
  children: ReactNode;
};

/** Additive edit-mode chrome around an existing widget body — in view mode
 * this renders no extra markup, so the canvas looks identical to today. The
 * `rgl-drag-handle` class is a plain (non-CSS-module) selector matched by
 * DashboardCanvas's `draggableHandle` prop. */
export function WidgetFrame({ widgetKey, title, isEditing, onRemove, children }: Props) {
  return (
    <div className={css.widgetFrame}>
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
