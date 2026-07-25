"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Alert } from "@/components/alert";
import {
  IconAlertTriangle,
  IconBox,
  IconCalendar,
  IconCheck,
  IconDownload,
  IconEdit,
  IconEye,
  IconPlus,
  IconSearch,
  IconUsers,
} from "@/components/icons";
import { ActionButton, DataTable, PageHeader, StatCard, StatusBadge, type Column } from "@/components/ui";
import { useAuth } from "@/lib/use-auth";
import { InventoryFilterSelect } from "../inventory/components/inventory-filter-select";
import inventoryCss from "../inventory/inventory.module.css";
import layoutCss from "../purchasing/purchasing.module.css";
import { CreateSupplierModal } from "./components/create-supplier-modal";
import { SupplierDetailModal } from "./components/supplier-detail-modal";
import {
  PAYMENT_TERMS_OPTIONS,
  STATUS_OPTIONS,
  SUMMARY_PERIOD_OPTIONS,
  TYPE_OPTIONS,
} from "./constants";
import { useSupplierSummary } from "./hooks/use-supplier-summary";
import { useSuppliersList } from "./hooks/use-suppliers";
import scss from "./suppliers.module.css";
import {
  PAGE_SIZE,
  type PaymentTermsFilter,
  type SummaryPeriod,
  type SupplierListItem,
  type SupplierStatusFilter,
  type SupplierType,
  type SupplierTypeFilter,
} from "./types";
import {
  displayStatusLabel,
  displayTypeLabel,
  exportSuppliersCsv,
  formatDate,
  formatMoney,
  formatTerms,
  hasSupplierWriteAccess,
  supplierInitials,
} from "./utils";

const TYPE_CHIP: Record<SupplierType, string> = {
  distributor: scss.typeDistributor,
  importer: scss.typeImporter,
  manufacturer: scss.typeManufacturer,
  wholesaler: scss.typeWholesaler,
  other: scss.typeOther,
};

const TOP_SUPPLIERS_VISIBLE = 5;
const RECENT_ACTIVITY_VISIBLE = 6;

export default function SuppliersPage() {
  const { user, branchId } = useAuth();
  const canWrite = hasSupplierWriteAccess(user, branchId);

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<SupplierStatusFilter>("all");
  const [typeFilter, setTypeFilter] = useState<SupplierTypeFilter>("all");
  const [termsFilter, setTermsFilter] = useState<PaymentTermsFilter>("all");
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [summaryPeriod, setSummaryPeriod] = useState<SummaryPeriod>("this_month");
  const [createOpen, setCreateOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailStartInEdit, setDetailStartInEdit] = useState(false);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, statusFilter, typeFilter, termsFilter, overdueOnly]);

  const suppliers = useSuppliersList({
    q: debouncedSearch,
    status: statusFilter,
    type: typeFilter,
    paymentTermsDays: termsFilter,
  });
  const summary = useSupplierSummary(summaryPeriod);

  const filteredRows = useMemo(
    () => (overdueOnly ? suppliers.rows.filter((r) => r.overdueAmount > 0) : suppliers.rows),
    [suppliers.rows, overdueOnly],
  );

  const hasActiveFilters =
    !!debouncedSearch ||
    statusFilter !== "all" ||
    typeFilter !== "all" ||
    termsFilter !== "all" ||
    overdueOnly;

  const paged = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filteredRows.slice(start, start + PAGE_SIZE);
  }, [page, filteredRows]);

  function clearFilters() {
    setSearch("");
    setDebouncedSearch("");
    setStatusFilter("all");
    setTypeFilter("all");
    setTermsFilter("all");
    setOverdueOnly(false);
  }

  function reloadAll() {
    void suppliers.reload();
    void summary.reload();
  }

  const columns: Column<SupplierListItem>[] = useMemo(
    () => [
      {
        key: "supplier",
        header: "Supplier",
        render: (row) => (
          <div className={scss.supplierCell}>
            <span className={scss.avatar} aria-hidden>
              {supplierInitials(row.name)}
            </span>
            <div className={scss.supplierText}>
              <button
                type="button"
                className={scss.supplierName}
                onClick={() => {
                  setDetailStartInEdit(false);
                  setDetailId(row.id);
                }}
              >
                {row.name}
              </button>
              <span className={scss.supplierMeta}>
                {row.code}
                {row.phone ? ` · ${row.phone}` : ""}
                {row.email ? ` · ${row.email}` : ""}
              </span>
            </div>
          </div>
        ),
      },
      {
        key: "type",
        header: "Type",
        width: "120px",
        render: (row) => (
          <span className={`${scss.typeTag} ${TYPE_CHIP[row.type] ?? scss.typeOther}`}>
            {displayTypeLabel(row.type)}
          </span>
        ),
      },
      {
        key: "status",
        header: "Status",
        width: "110px",
        render: (row) => (
          <StatusBadge status={row.status} label={displayStatusLabel(row.status)} />
        ),
      },
      {
        key: "terms",
        header: "Terms",
        width: "90px",
        render: (row) => formatTerms(row.paymentTermsDays),
      },
      {
        key: "outstanding",
        header: "Outstanding",
        align: "right",
        width: "140px",
        render: (row) => (
          <div className={scss.outstandingCell}>
            <span>{formatMoney(row.outstanding)}</span>
            {row.dueLabel ? (
              <span
                className={`${scss.dueLabel} ${
                  row.dueLabel.startsWith("Overdue") ? scss.dueOverdue : ""
                }`}
              >
                {row.dueLabel}
              </span>
            ) : null}
          </div>
        ),
      },
      {
        key: "lastOrder",
        header: "Last order",
        width: "120px",
        render: (row) => formatDate(row.lastOrderAt),
      },
      {
        key: "actions",
        header: "Actions",
        width: "88px",
        align: "right",
        render: (row) => (
          <div className={layoutCss.actionsCell}>
            <button
              type="button"
              className={`${layoutCss.actionIcon} ${layoutCss.actionIconView}`}
              onClick={() => {
                setDetailStartInEdit(false);
                setDetailId(row.id);
              }}
              aria-label={`View ${row.name}`}
              data-tooltip="View supplier"
            >
              <IconEye size={17} />
            </button>
            {canWrite ? (
              <button
                type="button"
                className={`${layoutCss.actionIcon} ${layoutCss.actionIconEdit}`}
                onClick={() => {
                  setDetailStartInEdit(true);
                  setDetailId(row.id);
                }}
                aria-label={`Edit ${row.name}`}
                data-tooltip="Edit supplier"
              >
                <IconEdit size={17} />
              </button>
            ) : null}
          </div>
        ),
      },
    ],
    [canWrite],
  );

  const totals = summary.data?.totals;
  const period = summary.data?.period;
  const topSuppliers = (summary.data?.topSuppliers ?? []).slice(0, TOP_SUPPLIERS_VISIBLE);
  const recentActivity = (summary.data?.recentActivity ?? []).slice(
    0,
    RECENT_ACTIVITY_VISIBLE,
  );

  return (
    <div className={layoutCss.page}>
      <PageHeader
        subtitleOnly
        floatingActions
        description="Supplier master data, outstanding payables, and recent purchasing activity."
        actions={
          canWrite ? (
            <ActionButton
              icon={<IconPlus size={16} />}
              tooltip="Create a new supplier"
              onClick={() => setCreateOpen(true)}
            >
              New supplier
            </ActionButton>
          ) : null
        }
      />

      {(suppliers.error || summary.error) && (
        <Alert variant="error">{suppliers.error ?? summary.error}</Alert>
      )}

      <div className={layoutCss.dashboard}>
        <div className={layoutCss.mainCol}>
          <div className={scss.kpiRow}>
            <StatCard
              title="Total suppliers"
              value={totals?.supplierCount ?? "—"}
              subtitle="All statuses"
              icon={<IconBox size={16} />}
              iconTone="info"
            />
            <StatCard
              title="Active"
              value={totals?.activeCount ?? "—"}
              subtitle="Ready for POs"
              icon={<IconUsers size={16} />}
              iconTone="success"
              active={statusFilter === "active"}
              onClick={() =>
                setStatusFilter((s) => (s === "active" ? "all" : "active"))
              }
            />
            <StatCard
              title="Total payable"
              value={totals ? formatMoney(totals.totalPayable) : "—"}
              subtitle="Open + partial"
              icon={<IconCalendar size={16} />}
              iconTone="primary"
            />
            <StatCard
              title="Overdue payable"
              value={totals ? formatMoney(totals.overduePayable) : "—"}
              subtitle="Past due balance"
              icon={<IconAlertTriangle size={16} />}
              iconTone="danger"
              active={overdueOnly}
              onClick={() => setOverdueOnly((v) => !v)}
            />
            <StatCard
              title="Orders this month"
              value={totals?.ordersThisMonth ?? "—"}
              subtitle="Excl. cancelled"
              icon={<IconCheck size={16} />}
              iconTone="success"
            />
          </div>

          <div className={layoutCss.toolbar}>
            <div className={layoutCss.searchWrap}>
              <IconSearch size={15} className={layoutCss.searchIcon} />
              <input
                type="search"
                className={layoutCss.searchInput}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name, code, phone, email…"
                aria-label="Search suppliers"
              />
            </div>
            <InventoryFilterSelect
              label="Status"
              value={statusFilter}
              options={STATUS_OPTIONS}
              onChange={(v) => setStatusFilter(v as SupplierStatusFilter)}
            />
            <InventoryFilterSelect
              label="Type"
              value={typeFilter}
              options={TYPE_OPTIONS}
              onChange={(v) => setTypeFilter(v as SupplierTypeFilter)}
            />
            <InventoryFilterSelect
              label="Payment terms"
              value={termsFilter}
              options={PAYMENT_TERMS_OPTIONS}
              onChange={(v) => setTermsFilter(v as PaymentTermsFilter)}
            />
            <span className={layoutCss.toolbarSpacer} />
            <button
              type="button"
              className={layoutCss.actionBtn}
              onClick={() => exportSuppliersCsv(filteredRows)}
              disabled={filteredRows.length === 0}
            >
              <IconDownload size={15} />
              Export
            </button>
          </div>

          {hasActiveFilters && (
            <div className={layoutCss.activeFilter}>
              <span>
                Filtered suppliers · {filteredRows.length} supplier
                {filteredRows.length === 1 ? "" : "s"}
              </span>
              <button
                type="button"
                className={layoutCss.clearFilter}
                onClick={clearFilters}
                data-tooltip="Reset all supplier filters"
              >
                Clear filter
              </button>
            </div>
          )}

          <DataTable
            columns={columns}
            data={paged}
            rowKey={(r) => r.id}
            loading={suppliers.loading}
            page={page}
            pageSize={PAGE_SIZE}
            total={filteredRows.length}
            onPageChange={setPage}
            emptyTitle={
              hasActiveFilters ? "No suppliers match your filters" : "No suppliers yet"
            }
            emptyDescription={
              hasActiveFilters
                ? "Try clearing filters or adjusting your search"
                : canWrite
                  ? "Create a supplier to start purchasing and tracking payables"
                  : "Suppliers for this tenant will appear here"
            }
            emptyIcon={<IconBox size={48} />}
            compact
          />
        </div>

        <aside className={layoutCss.sideCol}>
          <div className={layoutCss.sideCard}>
            <div className={inventoryCss.summaryHeader}>
              <h3 className={`${layoutCss.sideCardTitle} ${layoutCss.sideCardTitleFlush}`}>
                Period summary
              </h3>
              <InventoryFilterSelect
                label="Period"
                value={summaryPeriod}
                options={SUMMARY_PERIOD_OPTIONS}
                onChange={(value) => setSummaryPeriod(value as SummaryPeriod)}
              />
            </div>
            <p className={layoutCss.periodLabel}>{period?.label ?? "—"}</p>
            {summary.loading && !summary.data ? (
              <p className={layoutCss.fieldHint}>Loading summary…</p>
            ) : (
              <div className={layoutCss.summaryGrid}>
                <div className={layoutCss.summaryRow}>
                  <span>Purchase orders</span>
                  <span className={layoutCss.summaryValue}>{period?.orderCount ?? "—"}</span>
                </div>
                <div className={layoutCss.summaryRow}>
                  <span>Purchase value</span>
                  <span className={layoutCss.summaryValue}>
                    {period ? formatMoney(period.purchaseValue) : "—"}
                  </span>
                </div>
                <div className={layoutCss.summaryRow}>
                  <span>Invoices</span>
                  <span className={layoutCss.summaryValue}>{period?.invoiceCount ?? "—"}</span>
                </div>
                <div className={`${layoutCss.summaryRow} ${layoutCss.summaryHighlight}`}>
                  <span>Invoice total</span>
                  <span className={layoutCss.summaryValue}>
                    {period ? formatMoney(period.invoiceTotal) : "—"}
                  </span>
                </div>
              </div>
            )}
          </div>

          <div className={layoutCss.sideCard}>
            <h3 className={layoutCss.sideCardTitle}>Top suppliers by purchase</h3>
            {summary.loading && !summary.data ? (
              <p className={layoutCss.fieldHint}>Loading…</p>
            ) : topSuppliers.length === 0 ? (
              <p className={layoutCss.fieldHint}>No purchase activity in this period.</p>
            ) : (
              <>
                <ul className={scss.topList}>
                  {topSuppliers.map((s) => (
                    <li key={s.id} className={scss.topItem}>
                      <div>
                        <button
                          type="button"
                          className={scss.topName}
                          onClick={() => {
                            setDetailStartInEdit(false);
                            setDetailId(s.id);
                          }}
                        >
                          {s.name}
                        </button>
                        <div className={scss.topMeta}>
                          {s.code} · {s.orderCount} PO{s.orderCount === 1 ? "" : "s"}
                        </div>
                      </div>
                      <span className={scss.topValue}>{formatMoney(s.purchaseValue)}</span>
                    </li>
                  ))}
                </ul>
                <Link href="/purchasing" className={layoutCss.sideLink}>
                  View purchase details →
                </Link>
              </>
            )}
          </div>

          <div className={layoutCss.sideCard}>
            <h3 className={layoutCss.sideCardTitle}>Recent activity</h3>
            {summary.loading && !summary.data ? (
              <p className={layoutCss.fieldHint}>Loading…</p>
            ) : recentActivity.length === 0 ? (
              <p className={layoutCss.fieldHint}>No recent PO, GRN, or invoice activity.</p>
            ) : (
              <>
                <ul className={scss.activityList}>
                  {recentActivity.map((a) => (
                    <li key={`${a.kind}-${a.id}`} className={scss.activityItem}>
                      <div className={scss.activityTop}>
                        <span className={scss.activityLabel}>
                          <span className={scss.activityKind}>{a.kind.toUpperCase()}</span>
                          {a.label}
                        </span>
                        {a.amount != null ? (
                          <span className={scss.activityAmount}>{formatMoney(a.amount)}</span>
                        ) : null}
                      </div>
                      <span className={scss.activityMeta}>
                        {a.supplierName} · {formatDate(a.at)}
                      </span>
                    </li>
                  ))}
                </ul>
                <Link href="/purchasing" className={layoutCss.sideLink}>
                  View all activity →
                </Link>
              </>
            )}
          </div>
        </aside>
      </div>

      <CreateSupplierModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(id) => {
          reloadAll();
          setDetailStartInEdit(false);
          setDetailId(id);
        }}
      />

      <SupplierDetailModal
        open={!!detailId}
        supplierId={detailId}
        canWrite={canWrite}
        startInEdit={detailStartInEdit}
        onStartInEditConsumed={() => setDetailStartInEdit(false)}
        onClose={() => {
          setDetailId(null);
          setDetailStartInEdit(false);
        }}
        onChanged={reloadAll}
      />
    </div>
  );
}
