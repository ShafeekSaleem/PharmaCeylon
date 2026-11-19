"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Alert } from "@/components/alert";
import { IconShoppingCart, IconUserPlus } from "@/components/icons";
import { StatusStrip } from "@/components/ui";
import { useAuth } from "@/lib/use-auth";
import { useBranchRollout } from "@/lib/branch-rollout";
import { DailyWorkQueue } from "./components/daily-work-queue";
import { isV6DashboardRole } from "./components/dashboard-fixed-grid";
import { useRoleAccess } from "@/lib/use-role-access";
import { AddWidgetDrawer } from "./components/add-widget-drawer";
import { DashboardHeader } from "./components/dashboard-header";
import { useDashboardData } from "./hooks/use-dashboard-data";
import { useDashboardLayout } from "./hooks/use-dashboard-layout";
import { resolvePrimaryDashboardRole } from "./lib/dashboard-role";
import { shortcutsForRole } from "./lib/dashboard-shortcuts";
import {
  shouldShowLegacyFailedSectionsAlert,
  shouldShowV6ServerAlert,
} from "./lib/dashboard-v6-alerts";
import { dashboardPosHidden, PosHiddenContext } from "./lib/pos-links";
import { CashierDashboard } from "./roles/cashier-dashboard";
import { InventoryClerkDashboard } from "./roles/inventory-clerk-dashboard";
import { ManagerDashboard } from "./roles/manager-dashboard";
import { OwnerDashboard } from "./roles/owner-dashboard";
import { PharmacistDashboard } from "./roles/pharmacist-dashboard";
import { catalogForRole } from "./widgets/registry";
import css from "./dashboard.module.css";

export default function DashboardPage() {
  const { branchId, user } = useAuth();
  return (
    <DashboardWorkspace
      key={`${user?.tenantId ?? "none"}:${user?.id ?? "anonymous"}:${branchId ?? "none"}`}
    />
  );
}

function DashboardWorkspace() {
  const { userRoles } = useRoleAccess();
  const data = useDashboardData({ followBranch: true });
  const viewRole = useMemo(
    () => resolvePrimaryDashboardRole(userRoles),
    [userRoles],
  );

  // W9: at a live branch nothing here opens the web POS, and held-bill widgets leave the web.
  const rollout = useBranchRollout().rollout;
  const posHidden = dashboardPosHidden(rollout);
  const counterLive = rollout?.state === "live";
  const catalog = useMemo(
    () => catalogForRole(viewRole, posHidden),
    [viewRole, posHidden],
  );
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
    window.history.replaceState(
      null,
      "",
      `/dashboard${query ? `?${query}` : ""}`,
    );
  }, []);
  const activeKeys = useMemo(
    () => new Set(layout.layout.map((w) => w.key)),
    [layout.layout],
  );
  const shortcuts = useMemo(
    () => shortcutsForRole(viewRole),
    [viewRole],
  );
  const showV6ServerAlert = shouldShowV6ServerAlert(viewRole, data);
  const showLegacyFailedSections = shouldShowLegacyFailedSectionsAlert(
    viewRole,
    data,
  );

  return (
    <PosHiddenContext.Provider value={posHidden}>
      <div className={css.page}>
        <DashboardHeader
          role={viewRole}
          branchLabel={data.branchName}
          timeZone={data.salesMetrics?.timezone}
          loading={data.loading || data.refreshing}
          lastUpdatedAt={data.lastUpdatedAt}
          onRefresh={() => void data.reload()}
          shortcuts={
            isV6DashboardRole(viewRole) ? undefined : (shortcuts ?? undefined)
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
                {posHidden ? null : (
                  <Link href="/pos" className="status-strip-primary">
                    <IconShoppingCart size={15} /> Open POS
                  </Link>
                )}
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
                {posHidden ? null : (
                  <Link href="/pos" className="status-strip-primary">
                    <IconShoppingCart size={15} /> Open POS
                  </Link>
                )}
              </>
            }
            onDismiss={() => setInvitationAccepted(false)}
            dismissLabel="Dismiss invitation message"
          />
        ) : null}

        {!data.branchId ? (
          <Alert variant="warning">
            Select a branch in the header to load dashboard metrics.
          </Alert>
        ) : null}

        {data.error && !isV6DashboardRole(viewRole) ? (
          <Alert variant="error">{data.error}</Alert>
        ) : null}

        {showV6ServerAlert ? (
          <Alert variant="error" className={css.serverUnreachableAlert}>
            <strong>Can&apos;t reach the server</strong>
            <p>
              The figures below may be incomplete or out of date. Daily work,
              sales and inventory all need a connection.
            </p>
            <button
              type="button"
              className={css.serverUnreachableRetry}
              onClick={() => void data.reload()}
            >
              Try again
            </button>
          </Alert>
        ) : null}

        {showLegacyFailedSections ? (
          <Alert variant="warning">
            Couldn&apos;t load: {Array.from(data.failedSections).join(", ")}.
            The figures below may be incomplete —{" "}
            <button
              type="button"
              className={css.inlineLinkBtn}
              onClick={() => void data.reload()}
            >
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

        {isV6DashboardRole(viewRole) ? null : (
          <DailyWorkQueue
            role={viewRole}
            branchId={data.branchId}
            refreshKey={data.lastUpdatedAt}
          />
        )}

        {viewRole === "owner" ? (
          <OwnerDashboard
            data={data}
            catalog={catalog}
            layout={layout}
            refreshKey={data.lastUpdatedAt}
            counterLive={counterLive}
          />
        ) : null}
        {viewRole === "manager" ? (
          <ManagerDashboard
            data={data}
            catalog={catalog}
            layout={layout}
            refreshKey={data.lastUpdatedAt}
            counterLive={counterLive}
          />
        ) : null}
        {viewRole === "pharmacist" ? (
          <PharmacistDashboard data={data} catalog={catalog} layout={layout} />
        ) : null}
        {viewRole === "cashier" ? (
          <CashierDashboard data={data} catalog={catalog} layout={layout} />
        ) : null}
        {viewRole === "inventory_clerk" ? (
          <InventoryClerkDashboard
            data={data}
            catalog={catalog}
            layout={layout}
          />
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
    </PosHiddenContext.Provider>
  );
}
