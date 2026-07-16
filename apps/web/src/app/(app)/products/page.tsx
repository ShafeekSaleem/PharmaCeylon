"use client";

import { Suspense } from "react";
import { ProductsPageContent } from "./components/products-page-content";

export default function ProductsPage() {
  return (
    <Suspense fallback={<p style={{ padding: "1rem", color: "var(--pc-muted-fg)" }}>Loading…</p>}>
      <ProductsPageContent />
    </Suspense>
  );
}
