"use client";

import { Suspense } from "react";
import { useParams } from "next/navigation";
import { ProductDetailPage } from "../components/product-detail-page";

function ProductDetailRoute() {
  const params = useParams();
  const id = typeof params.id === "string" ? params.id : params.id?.[0];
  if (!id) {
    return <p style={{ color: "var(--pc-muted-fg)" }}>Invalid product.</p>;
  }
  return <ProductDetailPage productId={id} />;
}

export default function ProductDetailRoutePage() {
  return (
    <Suspense fallback={<p style={{ padding: "1rem", color: "var(--pc-muted-fg)" }}>Loading…</p>}>
      <ProductDetailRoute />
    </Suspense>
  );
}
