"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/ui/error-state";

/**
 * Boundary for the authenticated app. Sits inside `(app)/layout.tsx`, so the
 * sidebar, branch picker and search bar survive the failure and the person can
 * navigate away from a broken page instead of losing the whole shell.
 *
 * Widgets on the dashboard and reports compose many independent figures over
 * live tenant data, which is where an unexpected shape most plausibly throws.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Client render errors never reach the server logs on their own.
    console.error("[app] render error", error);
  }, [error]);

  return (
    <ErrorState onRetry={reset} digest={error.digest}>
      This page couldn’t be displayed. Your data hasn’t been changed — trying
      again usually loads it. If it keeps happening, use the navigation to
      continue working elsewhere.
    </ErrorState>
  );
}
