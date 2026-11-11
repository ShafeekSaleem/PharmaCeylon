"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { usePermissions } from "@/lib/permissions";
import SalesHistory from "./sales-history";
import PendingRefundApprovals from "./components/pending-refund-approvals";
import css from "./sales.module.css";

export default function SalesPage() {
  return (
    <Suspense fallback={null}>
      <SalesWorkspace />
    </Suspense>
  );
}

function SalesWorkspace() {
  const params = useSearchParams();
  const { permissionKeys, loading, hasLoadedOnce } = usePermissions();
  if (loading && !hasLoadedOnce) return null;
  const mayViewSales = permissionKeys.includes("sales.view");
  const mayApprove = permissionKeys.includes("returns.approve");
  const pending = mayApprove && (params.get("view") === "pending-approvals" || !mayViewSales);
  return (
    <div className={css.page}>
      <nav className={css.workspaceTabs} aria-label="Sales views">
        {mayViewSales && (
          <Link href="/sales" aria-current={!pending ? "page" : undefined}>
            Sales history
          </Link>
        )}
        {mayApprove && (
          <Link
            href="/sales?view=pending-approvals"
            aria-current={pending ? "page" : undefined}
          >
            Pending approvals
          </Link>
        )}
      </nav>
      {pending ? (
        <PendingRefundApprovals />
      ) : mayViewSales ? (
        <SalesHistory />
      ) : (
        <p>You don&apos;t have access to sales or refund approvals at this branch.</p>
      )}
    </div>
  );
}
