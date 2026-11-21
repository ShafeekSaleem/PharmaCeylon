"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { usePermissions } from "@/lib/permissions";
import { useAuth } from "@/lib/use-auth";
import SalesCollectedMoney from "./components/sales-collected-money";
import SalesIncidentNotes from "./components/sales-incident-notes";
import SalesPaymentRecovery from "./components/sales-payment-recovery";
import PendingRefundApprovals from "./components/pending-refund-approvals";
import { useSalesQueueCounts } from "./hooks/use-sales-queue-counts";
import {
  isSalesRecoveryQueueView,
  isSalesWorkspaceView,
  salesViewHref,
  type SalesWorkspaceView,
} from "./sales-views";
import SalesHistory from "./sales-history";
import css from "./sales.module.css";

export default function SalesPage() {
  return (
    <Suspense fallback={null}>
      <SalesWorkspace />
    </Suspense>
  );
}

function tabCount(n: number | null): string {
  if (n === null) return "";
  return ` (${n})`;
}

function resolveView(
  raw: string | null,
  mayViewSales: boolean,
  mayApprove: boolean,
  mayManage: boolean,
): SalesWorkspaceView | "history" {
  if (raw === "pending-approvals") {
    return mayApprove ? "pending-approvals" : mayViewSales ? "history" : "pending-approvals";
  }
  if (isSalesWorkspaceView(raw)) {
    if (isSalesRecoveryQueueView(raw) && !mayManage) {
      return mayViewSales ? "history" : mayApprove ? "pending-approvals" : "history";
    }
    return raw;
  }
  if (!mayViewSales && mayApprove) return "pending-approvals";
  return "history";
}

function SalesWorkspace() {
  const params = useSearchParams();
  const { branchId } = useAuth();
  const { permissionKeys, loading, hasLoadedOnce } = usePermissions();
  const mayViewSales = permissionKeys.includes("sales.view");
  const mayApprove = permissionKeys.includes("returns.approve");
  const mayManage = permissionKeys.includes("tenant.management");
  const queueCounts = useSalesQueueCounts(branchId, mayManage);
  if (loading && !hasLoadedOnce) return null;

  const view = resolveView(params.get("view"), mayViewSales, mayApprove, mayManage);

  return (
    <div className={css.page}>
      <nav className={css.workspaceTabs} aria-label="Sales views">
        {mayViewSales && (
          <Link href="/sales" aria-current={view === "history" ? "page" : undefined}>
            Sales history
          </Link>
        )}
        {mayApprove && (
          <Link
            href="/sales?view=pending-approvals"
            aria-current={view === "pending-approvals" ? "page" : undefined}
          >
            Pending approvals
          </Link>
        )}
        {mayManage && (
          <>
            <Link
              href={salesViewHref("incident-notes")}
              aria-current={view === "incident-notes" ? "page" : undefined}
            >
              Incident notes{tabCount(queueCounts.incidentNotes)}
            </Link>
            <Link
              href={salesViewHref("payment-recovery")}
              aria-current={view === "payment-recovery" ? "page" : undefined}
            >
              Payment recovery{tabCount(queueCounts.paymentRecovery)}
            </Link>
            <Link
              href={salesViewHref("unresolved-money")}
              aria-current={view === "unresolved-money" ? "page" : undefined}
            >
              Unresolved money{tabCount(queueCounts.collectedMoney)}
            </Link>
          </>
        )}
      </nav>
      {view === "pending-approvals" ? (
        <PendingRefundApprovals />
      ) : view === "incident-notes" ? (
        <SalesIncidentNotes />
      ) : view === "payment-recovery" ? (
        <SalesPaymentRecovery />
      ) : view === "unresolved-money" ? (
        <SalesCollectedMoney />
      ) : mayViewSales ? (
        <SalesHistory />
      ) : (
        <p>You don&apos;t have access to sales or refund approvals at this branch.</p>
      )}
    </div>
  );
}
