/** Sri Lanka is the only supported locale/currency today — see
 *  `common/currency.constants.ts` on the API for why. */
export function formatMoney(value: string | number): string {
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return "—";
  return `Rs ${n.toLocaleString("en-LK", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatDate(value: string | Date | null): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-LK", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(d);
}

export function exportCustomersCsv(
  rows: {
    fullName: string;
    phone: string | null;
    email: string | null;
    address: string | null;
    isActive: boolean;
    _count: { sales: number; prescriptions: number };
    createdAt: string;
  }[],
): void {
  const header = [
    "Name",
    "Phone",
    "Email",
    "Address",
    "Status",
    "Purchases",
    "Prescriptions",
    "Registered",
  ];
  const body = rows.map((r) => [
    r.fullName,
    r.phone ?? "",
    r.email ?? "",
    r.address ?? "",
    r.isActive ? "Active" : "Inactive",
    String(r._count.sales),
    String(r._count.prescriptions),
    formatDate(r.createdAt),
  ]);
  const csv = [header, ...body]
    .map((cols) => cols.map(escapeCsv).join(","))
    .join("\r\n");

  const blob = new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `customers-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

/** A leading =, +, - or @ makes Excel treat the cell as a formula. */
function escapeCsv(value: string): string {
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}
