"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/ui/error-state";
// global-error replaces the root layout entirely, so the stylesheet that layout
// imports is not applied here — it has to be pulled in again or the page renders
// unstyled, without even the --pc-* tokens the error card is built from.
import "./globals.css";

/**
 * Last-resort boundary: only reached when the root layout itself throws, which
 * takes the whole document down. React re-mounts from scratch, so this file has
 * to supply its own <html> and <body>.
 *
 * `reset()` is deliberately not offered — if the root layout failed, re-running
 * the same render almost always fails identically. A full reload is the honest
 * recovery, so that is what the button does.
 */
export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[global] render error", error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <ErrorState
          title="PharmaCeylon couldn’t start"
          onRetry={() => window.location.reload()}
          retryLabel="Reload"
          digest={error.digest}
          standalone
          homeHref="/login"
          homeLabel="Go to sign in"
        >
          The application failed to load. Reloading usually resolves it. If it
          continues, your connection to the server may be interrupted.
        </ErrorState>
      </body>
    </html>
  );
}
