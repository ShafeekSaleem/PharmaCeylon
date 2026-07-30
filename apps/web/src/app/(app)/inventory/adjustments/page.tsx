"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";
import css from "../inventory.module.css";

/**
 * Adjustments no longer live on their own page — every inventory sub-page opens the
 * same adjustment flow in a modal instead. This route stays as a thin redirect so old
 * links/bookmarks (and role-based nav rules keyed on this path) keep working.
 */
function AdjustmentsRedirect() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const next = new URLSearchParams();
    const productId = searchParams.get("productId");
    const batchId = searchParams.get("batchId");
    if (productId) next.set("productId", productId);
    if (batchId) next.set("batchId", batchId);
    next.set("openAdjustment", "1");
    router.replace(`/inventory?${next.toString()}`);
  }, [router, searchParams]);

  return <div className={css.loading}>Redirecting…</div>;
}

export default function InventoryAdjustmentsPage() {
  return (
    <Suspense fallback={<div className={css.loading}>Redirecting…</div>}>
      <AdjustmentsRedirect />
    </Suspense>
  );
}
