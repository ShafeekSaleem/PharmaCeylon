"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/ui/error-state";

/**
 * Root boundary — catches the unauthenticated routes (login, register, verify,
 * onboarding, invitation accept) and anything that escapes a nested boundary.
 * The root layout itself is covered by `global-error.tsx` instead.
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[root] render error", error);
  }, [error]);

  return (
    <ErrorState
      onRetry={reset}
      digest={error.digest}
      standalone
      homeHref="/login"
      homeLabel="Go to sign in"
    >
      Something went wrong while loading this page. Trying again usually fixes
      it — nothing you entered has been submitted.
    </ErrorState>
  );
}
