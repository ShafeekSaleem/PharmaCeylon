"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Alert } from "@/components/alert";
import { IconFileText, IconSearch } from "@/components/icons";
import {
  ActiveFilterBanner,
  DataTable,
  PageHeader,
  StatusBadge,
  type Column,
  type FilterPill,
} from "@/components/ui";
import { apiJson } from "@/lib/auth-client";
import { useAuth } from "@/lib/use-auth";
import { InventoryFilterSelect } from "../inventory/components/inventory-filter-select";
import { formatDate } from "../customers/utils";
import css from "../customers/customers.module.css";

const PAGE_SIZE = 25;

const VALIDITY_OPTIONS = [
  { value: "all", label: "All prescriptions" },
  { value: "valid", label: "Still valid" },
  { value: "expired", label: "Expired" },
];

type PrescriptionRow = {
  id: string;
  rxNumber: string;
  patientName: string;
  doctorName: string;
  doctorRegNo: string | null;
  issuedOn: string;
  validUntil: string | null;
  notes: string | null;
  customer: { id: string; fullName: string; phone: string | null } | null;
  _count: { sales: number };
};

/**
 * The dispensing register for the active branch.
 *
 * Prescriptions are branch-scoped by the schema (rxNumber is unique per
 * branch), so unlike the customer record — which deliberately spans branches —
 * this list follows whichever branch is selected in the header.
 */
export default function PrescriptionsPage() {
  const { branchId } = useAuth();
  const [q, setQ] = useState("");
  const [validity, setValidity] = useState("all");
  const [page, setPage] = useState(1);

  const [rows, setRows] = useState<PrescriptionRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!branchId) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      if (validity !== "all") params.set("validity", validity);
      params.set("page", String(page));
      params.set("pageSize", String(PAGE_SIZE));
      const res = await apiJson<{ items: PrescriptionRow[]; total: number }>(
        `/prescriptions/register?${params.toString()}`,
      );
      setRows(res.items);
      setTotal(res.total);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load prescriptions",
      );
      setRows([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [branchId, q, validity, page]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const filterActive = q.trim() !== "" || validity !== "all";
  const pills = useMemo<FilterPill[]>(() => {
    const list: FilterPill[] = [];
    if (q.trim()) list.push({ key: "q", label: `Search: ${q.trim()}` });
    if (validity !== "all") {
      list.push({
        key: "validity",
        label: validity === "valid" ? "Still valid" : "Expired",
      });
    }
    return list;
  }, [q, validity]);

  const columns: Column<PrescriptionRow>[] = [
    {
      key: "rxNumber",
      header: "Rx number",
      width: "9rem",
      sortable: true,
      getValue: (r) => r.rxNumber,
      render: (r) => <span className={css.nameMain}>{r.rxNumber}</span>,
    },
    {
      key: "patientName",
      header: "Patient",
      sortable: true,
      getValue: (r) => r.patientName,
      render: (r) => (
        <div className={css.nameCell}>
          <span className={css.nameMain}>{r.patientName}</span>
          {/* The linked customer is what turns a one-off slip into a history,
              so it's worth surfacing on the row rather than in the detail. */}
          <span className={css.nameSub}>
            {r.customer ? (
              <Link href={`/customers?open=${r.customer.id}`}>
                {r.customer.fullName}
              </Link>
            ) : (
              "Not linked to a customer"
            )}
          </span>
        </div>
      ),
    },
    {
      key: "doctorName",
      header: "Prescriber",
      sortable: true,
      getValue: (r) => r.doctorName,
      render: (r) => (
        <div className={css.nameCell}>
          <span className={css.nameMain}>Dr {r.doctorName}</span>
          {r.doctorRegNo ? (
            <span className={css.nameSub}>Reg {r.doctorRegNo}</span>
          ) : null}
        </div>
      ),
    },
    {
      key: "issuedOn",
      header: "Issued",
      width: "8rem",
      sortable: true,
      getValue: (r) => r.issuedOn,
      render: (r) => <span className={css.muted}>{formatDate(r.issuedOn)}</span>,
    },
    {
      key: "sales",
      header: "Dispensed",
      width: "7rem",
      align: "right",
      render: (r) => <span className={css.countCell}>{r._count.sales}</span>,
    },
    {
      key: "validUntil",
      header: "Validity",
      width: "10rem",
      render: (r) => {
        if (!r.validUntil) return <span className={css.muted}>No expiry</span>;
        const expired = new Date(r.validUntil) < new Date();
        return (
          <StatusBadge
            status={expired ? "expired" : "active"}
            label={expired ? "Expired" : `To ${formatDate(r.validUntil)}`}
          />
        );
      },
    },
  ];

  return (
    <div>
      <PageHeader
        title="Prescriptions"
        description="The dispensing register for this branch — what was presented, by whom, and whether it's still valid."
      />

      {error ? <Alert variant="error">{error}</Alert> : null}
      {!branchId ? (
        <Alert variant="info">
          Select a branch to see its prescription register.
        </Alert>
      ) : null}

      <div className={css.toolbar}>
        <div className={css.searchWrap}>
          <span className={css.searchIcon}>
            <IconSearch size={15} />
          </span>
          <input
            className={css.searchInput}
            placeholder="Search by Rx number, patient or prescriber"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <InventoryFilterSelect
          label="Validity"
          value={validity}
          onChange={(v) => {
            setValidity(v);
            setPage(1);
          }}
          options={VALIDITY_OPTIONS}
        />
      </div>

      <ActiveFilterBanner
        active={filterActive}
        summary={`Filtered prescriptions · ${total} ${total === 1 ? "result" : "results"}`}
        pills={pills}
        onClear={() => {
          setQ("");
          setValidity("all");
          setPage(1);
        }}
      />

      <DataTable
        columns={columns}
        data={rows}
        rowKey={(r) => r.id}
        loading={loading}
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        onPageChange={setPage}
        fixedLayout
        emptyIcon={<IconFileText size={22} />}
        emptyTitle={
          filterActive ? "No matching prescriptions" : "No prescriptions yet"
        }
        emptyDescription={
          filterActive
            ? "Try a different search, or clear the filter."
            : "Prescriptions recorded at the counter appear here."
        }
      />
    </div>
  );
}
