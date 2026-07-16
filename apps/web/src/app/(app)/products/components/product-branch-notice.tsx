"use client";

import { useAuth } from "@/lib/use-auth";
import detailCss from "../product-detail.module.css";

export function ProductBranchNotice() {
  const { branchId } = useAuth();

  if (branchId) return null;

  return (
    <div className={detailCss.branchNotice} role="status">
      <strong>Branch not selected.</strong> Stock, batches, and pricing require a branch. Choose one
      from the top bar to see branch-specific data.
    </div>
  );
}
