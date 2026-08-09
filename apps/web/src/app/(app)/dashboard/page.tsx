"use client";

import { useMemo } from "react";
import { Alert } from "@/components/alert";
import { useRoleAccess } from "@/lib/use-role-access";
import { DashboardHeader } from "./components/dashboard-header";
import { useDashboardData } from "./hooks/use-dashboard-data";
import { resolvePrimaryDashboardRole } from "./lib/dashboard-role";
import { AnalystDashboard } from "./roles/analyst-dashboard";
import { CashierDashboard } from "./roles/cashier-dashboard";
import { InventoryClerkDashboard } from "./roles/inventory-clerk-dashboard";
import { ManagerDashboard } from "./roles/manager-dashboard";
import { OwnerDashboard } from "./roles/owner-dashboard";
import { PharmacistDashboard } from "./roles/pharmacist-dashboard";
import css from "./dashboard.module.css";

export default function DashboardPage() {
  const { userRoles } = useRoleAccess();
  const data = useDashboardData();
  const viewRole = useMemo(() => resolvePrimaryDashboardRole(userRoles), [userRoles]);
  const isOwner = viewRole === "owner";
  const ownerThisBranch = isOwner && data.ownerScope === "this_branch";

  return (
    <div className={css.page}>
      <DashboardHeader
        role={viewRole}
        ownerScope={isOwner ? data.ownerScope : undefined}
        onOwnerScopeChange={isOwner ? data.setOwnerScope : undefined}
        branchLabel={data.branchLabel}
        loading={data.loading}
        lastUpdatedAt={data.lastUpdatedAt}
        onRefresh={() => void data.reload()}
        branchHint={
          isOwner
            ? ownerThisBranch
              ? "Overview metrics are for the shell’s active branch. Switch branch in the app header."
              : "Overview metrics cover every branch. Shell branch still applies to operational pages (POS, inventory)."
            : "Active branch — switch in the app header"
        }
      />

      {!data.branchId ? (
        <Alert variant="warning">Select a branch in the header to load dashboard metrics.</Alert>
      ) : null}

      {data.error ? <Alert variant="error">{data.error}</Alert> : null}

      {data.loading && data.branchId ? (
        <p className={css.muted} role="status" aria-live="polite">
          Loading dashboard metrics…
        </p>
      ) : null}

      {viewRole === "owner" ? <OwnerDashboard data={data} /> : null}
      {viewRole === "manager" ? <ManagerDashboard data={data} /> : null}
      {viewRole === "pharmacist" ? <PharmacistDashboard data={data} /> : null}
      {viewRole === "cashier" ? <CashierDashboard data={data} /> : null}
      {viewRole === "inventory_clerk" ? <InventoryClerkDashboard data={data} /> : null}
      {viewRole === "analyst" ? <AnalystDashboard data={data} /> : null}
    </div>
  );
}
