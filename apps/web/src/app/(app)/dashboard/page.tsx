"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Alert } from "@/components/alert";
import { IconShoppingCart, IconUserPlus } from "@/components/icons";
import { StatusStrip } from "@/components/ui";
import { useRoleAccess } from "@/lib/use-role-access";
import { AddWidgetDrawer } from "./components/add-widget-drawer";
import { DashboardHeader } from "./components/dashboard-header";
import { useDashboardData } from "./hooks/use-dashboard-data";
import { useDashboardLayout } from "./hooks/use-dashboard-layout";
import { resolvePrimaryDashboardRole } from "./lib/dashboard-role";
import { CashierDashboard } from "./roles/cashier-dashboard";
import { InventoryClerkDashboard } from "./roles/inventory-clerk-dashboard";
import { ManagerDashboard } from "./roles/manager-dashboard";
import { OwnerDashboard } from "./roles/owner-dashboard";
import { PharmacistDashboard } from "./roles/pharmacist-dashboard";
import { catalogForRole } from "./widgets/registry";
import css from "./dashboard.module.css";

export default function DashboardPage() {
  const { userRoles } = useRoleAccess();
  const data = useDashboardData();
  const viewRole = useMemo(() => resolvePrimaryDashboardRole(userRoles), [userRoles]);
  const isOwner = viewRole === "owner";
  const ownerThisBranch = isOwner && data.ownerScope === "this_branch";

  const catalog = useMemo(() => catalogForRole(viewRole), [viewRole]);
  const layout = useDashboardLayout(viewRole, catalog);
  const [addWidgetOpen, setAddWidgetOpen] = useState(false);
  const [setupComplete, setSetupComplete] = useState(false);
  const [invitationAccepted, setInvitationAccepted] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("setup") === "complete") {
      setSetupComplete(true);
      params.delete("setup");
    }
    if (params.get("invitation") === "accepted") {
      setInvitationAccepted(true);
      params.delete("invitation");
    }
    const query = params.toString();
    window.history.replaceState(null, "", `/dashboard${query ? `?${query}` : ""}`);
  }, []);
  const activeKeys = useMemo(() => new Set(layout.layout.map((w) => w.key)), [layout.layout]);

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
        customize={{
          isEditing: layout.isEditing,
          onToggleEdit: () => layout.setIsEditing(true),
          onOpenAddWidget: () => setAddWidgetOpen(true),
          onSave: () => void layout.save(),
          onDiscard: layout.discard,
          onResetToDefault: () => void layout.resetToDefault(),
          isDirty: layout.isDirty,
          saving: layout.saving,
        }}
      />

      {setupComplete ? (
        <StatusStrip
          className={css.readyStrip}
          label="Setup complete"
          emphasis={`${data.branchName || "Your branch"} is ready to serve customers`}
          actions={
            <>
              <Link href="/users">
                <IconUserPlus size={15} /> Invite team
              </Link>
              <Link href="/pos" className="status-strip-primary">
                <IconShoppingCart size={15} /> Open POS
              </Link>
            </>
          }
          onDismiss={() => setSetupComplete(false)}
          dismissLabel="Dismiss setup complete message"
        />
      ) : null}

      {invitationAccepted ? (
        <StatusStrip
          className={css.readyStrip}
          label="Workspace joined"
          emphasis="Your role and branch access are ready to use"
          actions={
            <>
              <Link href="/settings/my-profile">Review profile</Link>
              <Link href="/pos" className="status-strip-primary">
                <IconShoppingCart size={15} /> Open POS
              </Link>
            </>
          }
          onDismiss={() => setInvitationAccepted(false)}
          dismissLabel="Dismiss invitation message"
        />
      ) : null}

      {!data.branchId ? (
        <Alert variant="warning">Select a branch in the header to load dashboard metrics.</Alert>
      ) : null}

      {data.error ? <Alert variant="error">{data.error}</Alert> : null}

      {data.failedSections.size > 0 ? (
        <Alert variant="warning">
          Couldn&apos;t load: {Array.from(data.failedSections).join(", ")}. The figures below may be
          incomplete —{" "}
          <button type="button" className={css.inlineLinkBtn} onClick={() => void data.reload()}>
            try refreshing
          </button>
          .
        </Alert>
      ) : null}

      {data.loading && data.branchId ? (
        <p className={css.muted} role="status" aria-live="polite">
          Loading dashboard metrics…
        </p>
      ) : null}

      {viewRole === "owner" ? <OwnerDashboard data={data} catalog={catalog} layout={layout} /> : null}
      {viewRole === "manager" ? <ManagerDashboard data={data} catalog={catalog} layout={layout} /> : null}
      {viewRole === "pharmacist" ? <PharmacistDashboard data={data} catalog={catalog} layout={layout} /> : null}
      {viewRole === "cashier" ? <CashierDashboard data={data} catalog={catalog} layout={layout} /> : null}
      {viewRole === "inventory_clerk" ? (
        <InventoryClerkDashboard data={data} catalog={catalog} layout={layout} />
      ) : null}

      <AddWidgetDrawer
        open={addWidgetOpen}
        onClose={() => setAddWidgetOpen(false)}
        catalog={catalog}
        activeKeys={activeKeys}
        onAdd={(key) => {
          layout.addWidget(key);
          setAddWidgetOpen(false);
        }}
      />
    </div>
  );
}
