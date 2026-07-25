import type { AuthUser } from "@/lib/auth-types";
import { TYPE_OPTIONS } from "./constants";
import type {
  SupplierListItem,
  SupplierStatus,
  SupplierType,
} from "./types";

const WRITE_ROLES = new Set(["owner", "manager", "inventory_clerk"]);

export function hasSupplierWriteAccess(
  user: AuthUser | null,
  branchId?: string | null,
): boolean {
  if (!user) return false;
  if (user.branchRoles.some((br) => br.role === "owner")) return true;
  const scoped = branchId
    ? user.branchRoles.filter((br) => br.branchId === branchId)
    : user.branchRoles;
  return scoped.some((br) => WRITE_ROLES.has(br.role));
}

export function formatMoney(value: string | number | null | undefined): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return "—";
  return `LKR ${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatTerms(days: number): string {
  return `Net ${days}`;
}

export function displayTypeLabel(type: SupplierType | string): string {
  const found = TYPE_OPTIONS.find((o) => o.value === type);
  return found?.label ?? type.replace(/_/g, " ");
}

export function displayStatusLabel(status: SupplierStatus | string): string {
  switch (status) {
    case "active":
      return "Active";
    case "on_hold":
      return "On hold";
    case "inactive":
      return "Inactive";
    default:
      return status.replace(/_/g, " ");
  }
}

export function supplierInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase();
}

export function typeChipClass(type: SupplierType | string): string {
  switch (type) {
    case "distributor":
      return "typeDistributor";
    case "importer":
      return "typeImporter";
    case "manufacturer":
      return "typeManufacturer";
    case "wholesaler":
      return "typeWholesaler";
    default:
      return "typeOther";
  }
}

export function buildSuppliersQuery(params: {
  q?: string;
  status?: string;
  type?: string;
  paymentTermsDays?: string;
}): string {
  const qs = new URLSearchParams();
  if (params.q?.trim()) qs.set("q", params.q.trim());
  if (params.status && params.status !== "all") qs.set("status", params.status);
  if (params.type && params.type !== "all") qs.set("type", params.type);
  if (params.paymentTermsDays && params.paymentTermsDays !== "all") {
    qs.set("paymentTermsDays", params.paymentTermsDays);
  }
  const s = qs.toString();
  return s ? `?${s}` : "";
}

export function exportSuppliersCsv(rows: SupplierListItem[]) {
  const headers = [
    "Code",
    "Name",
    "Type",
    "Status",
    "Phone",
    "Email",
    "Contact",
    "Payment terms (days)",
    "Outstanding",
    "Overdue",
    "Due label",
    "Last order",
  ];
  const escape = (v: string | number | null | undefined) => {
    const s = v == null ? "" : String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [
    headers.join(","),
    ...rows.map((r) =>
      [
        r.code,
        r.name,
        r.type,
        r.status,
        r.phone,
        r.email,
        r.contactName,
        r.paymentTermsDays,
        r.outstanding,
        r.overdueAmount,
        r.dueLabel,
        r.lastOrderAt ? formatDate(r.lastOrderAt) : "",
      ]
        .map(escape)
        .join(","),
    ),
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `suppliers-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
