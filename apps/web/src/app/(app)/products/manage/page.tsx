"use client";

import { Suspense } from "react";
import { ManagePageContent } from "./manage-page-content";

export default function CatalogManagePage() {
  return (
    <Suspense
      fallback={<p style={{ padding: "1rem", color: "var(--pc-muted-fg)" }}>Loading…</p>}
    >
      <ManagePageContent />
    </Suspense>
  );
}
