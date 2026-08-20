"use client";

import { Suspense } from "react";
import { ReportsWorkspace } from "./components/reports-workspace";

export default function ReportsPage() {
  return (
    <Suspense fallback={<p className="pc-muted">Loading reports…</p>}>
      <ReportsWorkspace />
    </Suspense>
  );
}
