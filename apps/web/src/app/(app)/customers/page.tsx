"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Alert } from "@/components/alert";
import {
  IconDownload,
  IconPlus,
  IconSearch,
  IconUsers,
} from "@/components/icons";
import {
  ActionButton,
  ActiveFilterBanner,
  DataTable,
  PageHeader,
  StatusBadge,
  type Column,
  type FilterPill,
} from "@/components/ui";
import { RowMenu } from "@/components/ui";
import { usePermissions } from "@/lib/permissions";
import { InventoryFilterSelect } from "../inventory/components/inventory-filter-select";
import { CustomerDetailModal } from "./components/customer-detail-modal";
import { CustomerFormModal } from "./components/customer-form-modal";
import { useCustomersList } from "./hooks/use-customers";
import css from "./customers.module.css";
import {
  PAGE_SIZE,
  type Customer,
  type CustomerListItem,
  type CustomerStatusFilter,
} from "./types";
import { exportCustomersCsv, formatDate } from "./utils";

const STATUS_OPTIONS = [
  { value: "all", label: "All customers" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Deactivated" },
];

/** `useSearchParams` needs a Suspense boundary for this route to stay static. */
export default function CustomersPage() {
  return (
    <Suspense fallback={null}>
      <CustomersPageContent />
    </Suspense>
  );
}

function CustomersPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { permissionKeys } = usePermissions();
  const canCreate = permissionKeys.includes("customers.create");
  const canManage = permissionKeys.includes("customers.manage");

  const [q, setQ] = useState("");
  const [status, setStatus] = useState<CustomerStatusFilter>("all");
  const [page, setPage] = useState(1);

  const [detailId, setDetailId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Customer | null>(null);

  const { rows, total, loading, error, reload } = useCustomersList({
    q,
    status,
    page,
  });

  // Deep link from elsewhere in the app (a Prescriptions row naming its
  // customer). Consumed once, then stripped so a refresh doesn't reopen it.
  const openParam = searchParams.get("open");
  useEffect(() => {
    if (!openParam) return;
    setDetailId(openParam);
    router.replace("/customers");
  }, [openParam, router]);

  const filterActive = q.trim() !== "" || status !== "all";
  const pills = useMemo<FilterPill[]>(() => {
    const list: FilterPill[] = [];
    if (q.trim()) list.push({ key: "q", label: `Search: ${q.trim()}` });
    if (status !== "all") {
      list.push({
        key: "status",
        label: status === "active" ? "Active only" : "Deactivated only",
      });
    }
    return list;
  }, [q, status]);

  function openCreate() {
    setEditing(null);
    setFormOpen(true);
  }

  function openEdit(row: Customer) {
    setEditing(row);
    setFormOpen(true);
  }

  async function toggleActive(row: CustomerListItem) {
    const { apiJson } = await import("@/lib/auth-client");
    await apiJson(`/customers/${row.id}`, {
      method: "PATCH",
      body: JSON.stringify({ isActive: !row.isActive }),
    });
    void reload();
  }

  const columns: Column<CustomerListItem>[] = [
    {
      key: "fullName",
      header: "Customer",
      sortable: true,
      getValue: (r) => r.fullName,
      render: (r) => (
        <div className={css.nameCell}>
          <span className={css.nameMain}>{r.fullName}</span>
          <span className={css.nameSub}>
            {[r.phone, r.email].filter(Boolean).join(" · ") || "No contact details"}
          </span>
        </div>
      ),
    },
    {
      key: "sales",
      header: "Purchases",
      align: "right",
      width: "7rem",
      sortable: true,
      getValue: (r) => r._count.sales,
      render: (r) => <span className={css.countCell}>{r._count.sales}</span>,
    },
    {
      key: "prescriptions",
      header: "Prescriptions",
      align: "right",
      width: "8rem",
      sortable: true,
      getValue: (r) => r._count.prescriptions,
      render: (r) => (
        <span className={css.countCell}>{r._count.prescriptions}</span>
      ),
    },
    {
      key: "createdAt",
      header: "Registered",
      width: "9rem",
      sortable: true,
      getValue: (r) => r.createdAt,
      render: (r) => <span className={css.muted}>{formatDate(r.createdAt)}</span>,
    },
    {
      key: "status",
      header: "Status",
      width: "7rem",
      render: (r) =>
        r.isActive ? (
          <StatusBadge status="active" />
        ) : (
          <StatusBadge status="inactive" label="Deactivated" />
        ),
    },
    {
      key: "actions",
      header: "",
      width: "3rem",
      align: "right",
      render: (r) => (
        <RowMenu
          label={`Actions for ${r.fullName}`}
          actions={[
            {
              label: "View record",
              onClick: () => setDetailId(r.id),
            },
            ...(canManage
              ? [
                  { label: "Edit", onClick: () => openEdit(r) },
                  {
                    label: r.isActive ? "Deactivate" : "Reactivate",
                    onClick: () => void toggleActive(r),
                    separated: true,
                    hint: r.isActive
                      ? "Keeps their history; hides them from the counter picker."
                      : undefined,
                  },
                ]
              : []),
          ]}
        />
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Customers"
        description="The people you dispense to — purchase history, prescriptions and contact details."
        actions={
          <>
            <ActionButton
              variant="secondary"
              onClick={() => exportCustomersCsv(rows)}
              disabled={rows.length === 0}
            >
              <IconDownload size={15} /> Export CSV
            </ActionButton>
            {canCreate ? (
              <ActionButton onClick={openCreate}>
                <IconPlus size={15} /> Add customer
              </ActionButton>
            ) : null}
          </>
        }
      />

      {error ? <Alert variant="error">{error}</Alert> : null}

      <div className={css.toolbar}>
        <div className={css.searchWrap}>
          <span className={css.searchIcon}>
            <IconSearch size={15} />
          </span>
          <input
            className={css.searchInput}
            placeholder="Search by name, phone or email"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <InventoryFilterSelect
          label="Status"
          value={status}
          onChange={(v) => {
            setStatus(v as CustomerStatusFilter);
            setPage(1);
          }}
          options={STATUS_OPTIONS}
        />
      </div>

      <ActiveFilterBanner
        active={filterActive}
        summary={`Filtered customers · ${total} ${total === 1 ? "result" : "results"}`}
        pills={pills}
        onClear={() => {
          setQ("");
          setStatus("all");
          setPage(1);
        }}
      />

      <DataTable
        columns={columns}
        data={rows}
        rowKey={(r) => r.id}
        loading={loading}
        onRowClick={(r) => setDetailId(r.id)}
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        onPageChange={setPage}
        fixedLayout
        emptyIcon={<IconUsers size={22} />}
        emptyTitle={filterActive ? "No matching customers" : "No customers yet"}
        emptyDescription={
          filterActive
            ? "Try a different search, or clear the filter."
            : "Customers registered at the counter appear here with their purchase and prescription history."
        }
      />

      <CustomerDetailModal
        customerId={detailId}
        onClose={() => setDetailId(null)}
        canManage={canManage}
        onEdit={() => {
          const row = rows.find((r) => r.id === detailId);
          if (row) {
            setDetailId(null);
            openEdit(row);
          }
        }}
      />

      <CustomerFormModal
        open={formOpen}
        customer={editing}
        onClose={() => setFormOpen(false)}
        onSaved={reload}
      />
    </div>
  );
}
