"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Alert } from "@/components/alert";
import {
  IconActivity,
  IconAlertTriangle,
  IconDownload,
  IconLock,
  IconSearch,
  IconUsers,
} from "@/components/icons";
import {
  ActionButton,
  ActiveFilterBanner,
  DataTable,
  PageHeader,
  StatCard,
  StatusBadge,
  type Column,
  type FilterPill,
} from "@/components/ui";
import { useAuth } from "@/lib/use-auth";
import { InventoryFilterSelect } from "../inventory/components/inventory-filter-select";
import layoutCss from "../purchasing/purchasing.module.css";
import scss from "./audit.module.css";
import {
  ACTION_OPTIONS,
  DATE_RANGE_OPTIONS,
  DEFAULT_FILTERS,
  MODULE_OPTIONS,
  PAGE_SIZE,
  QUICK_CAPSULES,
} from "./constants";
import { useAuditEvents } from "./hooks/use-audit-events";
import { useAuditSummary } from "./hooks/use-audit-summary";
import type { AuditEventRow, AuditFilters } from "./types";
import {
  auditEntityHref,
  auditEntityLabel,
  auditEventIcon,
  auditEventTone,
  exportAuditEventsCsv,
  formatAuditEventLabel,
  formatDateTime,
  summarizeAuditPayload,
  type AuditTone,
} from "./utils";

const TONE_CLASS: Record<AuditTone, string> = {
  teal: scss.evTeal,
  blue: scss.evBlue,
  amber: scss.evAmber,
  red: scss.evRed,
};

export default function AuditPage() {
  return (
    <Suspense fallback={<div className={layoutCss.loading}>Loading audit log…</div>}>
      <AuditPageContent />
    </Suspense>
  );
}

function filtersFromSearchParams(searchParams: ReturnType<typeof useSearchParams>): AuditFilters {
  const entityName = searchParams.get("entityName");
  const entityId = searchParams.get("entityId");
  if (!entityName || !entityId) return DEFAULT_FILTERS;
  return {
    ...DEFAULT_FILTERS,
    entityName,
    entityId,
    entityLabel: searchParams.get("entityLabel"),
  };
}

function AuditPageContent() {
  const searchParams = useSearchParams();
  const { branchId } = useAuth();
  // Read the deep-link scope synchronously on first render (rather than via an effect
  // that fires after mount) so there is never an unfiltered fetch that a moment later
  // races the real, scoped one — see the requestId guard in useAuditEvents for the rest
  // of that fix.
  const [filters, setFilters] = useState<AuditFilters>(() => filtersFromSearchParams(searchParams));
  const [page, setPage] = useState(1);
  const effectiveBranchId = filters.branchScope === "branch" && branchId ? branchId : undefined;

  useEffect(() => {
    const entityName = searchParams.get("entityName");
    const entityId = searchParams.get("entityId");
    if (entityName && entityId) {
      setFilters((f) =>
        f.entityId === entityId
          ? f
          : { ...f, entityName, entityId, entityLabel: searchParams.get("entityLabel") },
      );
    }
    // Only reacts to a genuinely new deep link after mount (e.g. clicking another
    // entity's "view audit trail" link while already on this page) — the initial
    // value is handled by the lazy useState above, not here.
  }, [searchParams]);

  useEffect(() => {
    setPage(1);
  }, [
    filters.q,
    filters.module,
    filters.action,
    filters.severity,
    filters.dateRange,
    filters.branchScope,
    filters.entityName,
    filters.entityId,
    effectiveBranchId,
  ]);

  const events = useAuditEvents(filters, page, effectiveBranchId);
  const summary = useAuditSummary(effectiveBranchId);
  const totals = summary.data;

  const activeCapsuleKey = useMemo(() => {
    const match = QUICK_CAPSULES.find(
      (c) =>
        c.module === filters.module &&
        c.severity === filters.severity &&
        c.dateRange === filters.dateRange,
    );
    return match?.key ?? null;
  }, [filters.module, filters.severity, filters.dateRange]);

  function applyCapsule(capsule: (typeof QUICK_CAPSULES)[number]) {
    setFilters((f) => ({
      ...f,
      module: capsule.module,
      severity: capsule.severity,
      dateRange: capsule.dateRange,
    }));
  }

  const hasActiveFilters =
    !!filters.q ||
    filters.module !== "all" ||
    filters.action !== "all" ||
    filters.severity !== "all" ||
    filters.dateRange !== "all" ||
    filters.branchScope !== "all";

  const activeFilterPills: FilterPill[] = [
    ...(filters.branchScope === "branch" ? [{ key: "branch", label: "This branch only" }] : []),
    ...(filters.module !== "all"
      ? [{ key: "module", label: MODULE_OPTIONS.find((o) => o.value === filters.module)?.label ?? filters.module }]
      : []),
    ...(filters.action !== "all"
      ? [{ key: "action", label: ACTION_OPTIONS.find((o) => o.value === filters.action)?.label ?? filters.action }]
      : []),
    ...(filters.severity === "critical" ? [{ key: "severity", label: "Critical only" }] : []),
    ...(filters.dateRange !== "all"
      ? [
          {
            key: "date",
            label: DATE_RANGE_OPTIONS.find((o) => o.value === filters.dateRange)?.label ?? filters.dateRange,
          },
        ]
      : []),
  ];

  function clearFilters() {
    setFilters((f) => ({
      ...DEFAULT_FILTERS,
      entityName: f.entityName,
      entityId: f.entityId,
      entityLabel: f.entityLabel,
    }));
  }

  function clearEntityScope() {
    setFilters((f) => ({ ...f, entityName: null, entityId: null, entityLabel: null }));
  }

  const columns: Column<AuditEventRow>[] = useMemo(
    () => [
      {
        key: "createdAt",
        header: "Date & time",
        width: "150px",
        render: (row) => <span className={layoutCss.muted}>{formatDateTime(row.createdAt)}</span>,
      },
      {
        key: "event",
        header: "Event",
        width: "230px",
        render: (row) => {
          const tone = auditEventTone(row.eventName, row.critical);
          const Icon = auditEventIcon(row.eventName);
          return (
            <span className={scss.eventCell}>
              <span className={`${scss.evIcon} ${TONE_CLASS[tone]}`}>
                <Icon size={13} />
              </span>
              {formatAuditEventLabel(row.eventName)}
              {row.critical ? (
                <StatusBadge
                  status="critical"
                  variant="danger"
                  label={row.eventName.startsWith("auth.") ? "Security" : "Critical"}
                />
              ) : null}
            </span>
          );
        },
      },
      {
        key: "entity",
        header: "Entity",
        width: "230px",
        render: (row) => {
          const href = auditEntityHref(row.entityName, row.entityId);
          const typeLabel = auditEntityLabel(row.entityName);
          const display = row.entityLabel ?? `${row.entityId.slice(0, 8)}…`;
          return (
            <span className={scss.entityCell} title={display}>
              <span className={scss.entityType}>{typeLabel} · </span>
              {href ? (
                <Link href={href} className={scss.entityLink}>
                  {display}
                </Link>
              ) : (
                <span className={layoutCss.muted}>{display}</span>
              )}
            </span>
          );
        },
      },
      {
        key: "actor",
        header: "Actor",
        width: "140px",
        render: (row) => row.actor?.fullName ?? <span className={layoutCss.muted}>System</span>,
      },
      {
        key: "branch",
        header: "Branch",
        width: "110px",
        render: (row) => row.branch?.name ?? <span className={layoutCss.muted}>—</span>,
      },
      {
        key: "details",
        header: "Details",
        width: "230px",
        render: (row) => {
          const summary = summarizeAuditPayload(row.eventName, row.payload);
          return (
            <span className={scss.detailsCell} title={summary ?? undefined}>
              {summary ?? "—"}
            </span>
          );
        },
      },
    ],
    [],
  );

  return (
    <div className={layoutCss.page}>
      <PageHeader
        subtitleOnly
        floatingActions
        description="Tenant-wide activity trail — every create, update, and status change across products, orders, sales, and users, with who did it and when."
        actions={
          <ActionButton
            variant="secondary"
            icon={<IconDownload size={16} />}
            tooltip="Export the current page of results as CSV"
            onClick={() => exportAuditEventsCsv(events.items)}
            disabled={events.items.length === 0}
          >
            Export CSV
          </ActionButton>
        }
      />

      {(events.error || summary.error) && <Alert variant="error">{events.error ?? summary.error}</Alert>}

      {filters.entityName && filters.entityId ? (
        <ActiveFilterBanner
          active
          summary={`Filtered to ${auditEntityLabel(filters.entityName)}`}
          pills={[
            { key: "entity", label: filters.entityLabel ?? `${filters.entityId.slice(0, 8)}…` },
          ]}
          onClear={clearEntityScope}
          clearTooltip="Show audit events for all entities"
        />
      ) : null}

      <div className={scss.kpiRow}>
        <StatCard
          size="sm"
          title="Events today"
          value={totals?.eventsToday ?? "—"}
          subtitle="Since midnight"
          icon={<IconActivity size={16} />}
          iconTone="info"
          active={filters.dateRange === "today"}
          onClick={() => setFilters((f) => ({ ...f, dateRange: f.dateRange === "today" ? "all" : "today" }))}
        />
        <StatCard
          size="sm"
          title="Active actors"
          value={totals?.activeActors ?? "—"}
          subtitle="Staff who logged actions today"
          icon={<IconUsers size={16} />}
          iconTone="primary"
          active={filters.dateRange === "today"}
          onClick={() => setFilters((f) => ({ ...f, dateRange: f.dateRange === "today" ? "all" : "today" }))}
        />
        <StatCard
          size="sm"
          title="Critical actions"
          value={totals?.criticalActions ?? "—"}
          subtitle="Voids, deletions, role changes"
          icon={<IconAlertTriangle size={16} />}
          iconTone="danger"
          active={filters.severity === "critical"}
          onClick={() => setFilters((f) => ({ ...f, severity: f.severity === "critical" ? "all" : "critical" }))}
        />
        <StatCard
          size="sm"
          title="Failed logins"
          value={totals?.failedLogins ?? "—"}
          subtitle="Since midnight"
          icon={<IconLock size={16} />}
          iconTone="danger"
          active={filters.action === "login_failed"}
          onClick={() =>
            setFilters((f) => ({ ...f, action: f.action === "login_failed" ? "all" : "login_failed" }))
          }
        />
      </div>

      <div className={scss.capsuleRow} role="tablist" aria-label="Quick filters">
        {QUICK_CAPSULES.map((c) => (
          <button
            key={c.key}
            type="button"
            role="tab"
            aria-selected={activeCapsuleKey === c.key}
            className={`${scss.capsule} ${activeCapsuleKey === c.key ? scss.capsuleActive : ""}`}
            onClick={() => applyCapsule(c)}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className={layoutCss.toolbar}>
        <div className={scss.scopeToggle} role="tablist" aria-label="Branch scope">
          <button
            type="button"
            role="tab"
            aria-selected={filters.branchScope === "all"}
            className={`${scss.scopeBtn} ${filters.branchScope === "all" ? scss.scopeBtnActive : ""}`}
            onClick={() => setFilters((f) => ({ ...f, branchScope: "all" }))}
          >
            All branches
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filters.branchScope === "branch"}
            className={`${scss.scopeBtn} ${filters.branchScope === "branch" ? scss.scopeBtnActive : ""}`}
            onClick={() => setFilters((f) => ({ ...f, branchScope: "branch" }))}
            disabled={!branchId}
            data-tooltip={branchId ? undefined : "Select a branch first"}
          >
            This branch
          </button>
        </div>
        <div className={layoutCss.searchWrap}>
          <IconSearch size={15} className={layoutCss.searchIcon} />
          <input
            type="search"
            className={layoutCss.searchInput}
            value={filters.q}
            onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
            placeholder="Search by event, entity, or actor…"
            aria-label="Search audit events"
          />
        </div>
        <InventoryFilterSelect
          label="Module"
          value={filters.module}
          options={MODULE_OPTIONS}
          onChange={(v) => setFilters((f) => ({ ...f, module: v as AuditFilters["module"] }))}
        />
        <InventoryFilterSelect
          label="Action"
          value={filters.action}
          options={ACTION_OPTIONS}
          onChange={(v) => setFilters((f) => ({ ...f, action: v }))}
        />
        <InventoryFilterSelect
          label="Date range"
          value={filters.dateRange}
          options={DATE_RANGE_OPTIONS}
          onChange={(v) => setFilters((f) => ({ ...f, dateRange: v as AuditFilters["dateRange"] }))}
        />
        <span className={layoutCss.toolbarSpacer} />
      </div>

      <ActiveFilterBanner
        active={hasActiveFilters}
        summary={`Filtered · ${events.total} event${events.total === 1 ? "" : "s"}`}
        pills={activeFilterPills}
        onClear={clearFilters}
        clearTooltip="Reset all audit filters"
      />

      <DataTable
        columns={columns}
        data={events.items}
        rowKey={(r) => r.id}
        rowClassName={(r) => (r.critical ? scss.rowCritical : undefined)}
        loading={events.loading}
        page={page}
        pageSize={PAGE_SIZE}
        total={events.total}
        onPageChange={setPage}
        emptyTitle={hasActiveFilters ? "No events match your filters" : "No audit events yet"}
        emptyDescription={
          hasActiveFilters
            ? "Try clearing filters or adjusting your search"
            : "Activity across the tenant will appear here as it happens"
        }
        emptyIcon={<IconActivity size={48} />}
        compact
      />
    </div>
  );
}
