import type { ReactNode } from "react";
import css from "./error-state.module.css";

export type ErrorStateProps = {
  title?: string;
  /** What the person should understand and do. Keep it actionable, not apologetic. */
  children?: ReactNode;
  /** Re-runs the failed render. Omitted on the global boundary, where only a
   *  full document reload can recover. */
  onRetry?: () => void;
  retryLabel?: string;
  /** Next attaches this to server-side errors; it is the only handle support has
   *  for finding the matching log entry. */
  digest?: string;
  /** `true` when this replaces the entire document (global-error) rather than
   *  rendering inside the app shell. */
  standalone?: boolean;
  /** Where the secondary escape hatch goes. Defaults to the dashboard, which is
   *  right inside the app but wrong on the signed-out routes — the root boundary
   *  points at sign-in instead. */
  homeHref?: string;
  homeLabel?: string;
};

/**
 * Shared presentation for the App Router error boundaries.
 *
 * Kept in `components/ui` rather than beside a route because both `error.tsx`
 * and `global-error.tsx` render it, and the two must not drift into looking
 * like different products at the worst possible moment.
 */
export function ErrorState({
  title = "Something went wrong",
  children,
  onRetry,
  retryLabel = "Try again",
  digest,
  standalone = false,
  homeHref = "/dashboard",
  homeLabel = "Go to dashboard",
}: ErrorStateProps) {
  return (
    <div
      className={`${css.wrap}${standalone ? ` ${css.wrapStandalone}` : ""}`}
      role="alert"
    >
      <div className={css.card}>
        <div className={css.icon}>
          <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden>
            <path
              fillRule="evenodd"
              d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495ZM10 5a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 10 5Zm0 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"
              clipRule="evenodd"
            />
          </svg>
        </div>

        <h1 className={css.title}>{title}</h1>
        <p className={css.body}>{children}</p>

        <div className={css.actions}>
          {onRetry ? (
            <button
              type="button"
              className={`${css.btn} ${css.btnPrimary}`}
              onClick={onRetry}
            >
              {retryLabel}
            </button>
          ) : null}
          {/* A plain anchor, not next/link: the router is the thing that just
              failed, so a full document navigation is the reliable escape. */}
          <a href={homeHref} className={`${css.btn} ${css.btnSecondary}`}>
            {homeLabel}
          </a>
        </div>

        {digest ? (
          <p className={css.digest}>
            Quote this reference if you contact support:{" "}
            <code className={css.digestCode}>{digest}</code>
          </p>
        ) : null}
      </div>
    </div>
  );
}
