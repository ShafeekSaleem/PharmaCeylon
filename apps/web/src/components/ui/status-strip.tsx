"use client";

import type { ReactNode } from "react";
import { IconCheck, IconX } from "@/components/icons";
import css from "./status-strip.module.css";

type Props = {
  /** The quiet half of the sentence — "Workspace created", "Setup complete". */
  label: string;
  /** The half worth reading — a workspace or branch name, in bold. */
  emphasis?: string;
  /** Defaults to a tick. Anything else should still be a single small glyph. */
  icon?: ReactNode;
  /** Links or buttons, pushed to the trailing edge. */
  actions?: ReactNode;
  onDismiss?: () => void;
  dismissLabel?: string;
  className?: string;
};

/**
 * The one-line "this is done" strip: a filled tick, a short sentence, and whatever comes next.
 *
 * Get Started and the Dashboard both announce the same milestone moments and had grown two
 * unrelated designs for it — a slim gradient strip on one, a two-line card with a square icon
 * tile on the other — so finishing setup on one page and landing on the other looked like
 * arriving somewhere else. This is that strip, once.
 *
 * Deliberately one line. The second line these banners carried ("All required setup checks are
 * complete…") restated the headline in more words, and it is the headline people read.
 */
export function StatusStrip({
  label,
  emphasis,
  icon,
  actions,
  onDismiss,
  dismissLabel = "Dismiss",
  className,
}: Props) {
  return (
    <section
      className={`${css.strip}${className ? ` ${className}` : ""}`}
      role="status"
    >
      <span className={css.icon}>{icon ?? <IconCheck size={17} />}</span>
      <p className={css.message}>
        {label}
        {emphasis && (
          <>
            <i className={css.sep}>·</i>
            <strong>{emphasis}</strong>
          </>
        )}
      </p>
      {actions && <div className={css.actions}>{actions}</div>}
      {onDismiss && (
        <button
          type="button"
          className={css.dismiss}
          onClick={onDismiss}
          aria-label={dismissLabel}
        >
          <IconX size={14} />
        </button>
      )}
    </section>
  );
}
