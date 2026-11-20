import { StatusBadge, type BadgeVariant } from "@/components/ui";
import type { SaleStatus } from "./types";

export type OfflineSyncState = "accepted" | "pending_stock_posting" | "held";

const SYNC_LIST_LABELS: Record<OfflineSyncState, string> = {
  accepted: "Accepted",
  pending_stock_posting: "Pending stock",
  held: "Held",
};

const SYNC_DETAIL_LABELS: Record<OfflineSyncState, string> = {
  accepted: "Accepted",
  pending_stock_posting: "Pending stock posting",
  held: "Held",
};

const SYNC_VARIANTS: Record<OfflineSyncState, BadgeVariant> = {
  accepted: "success",
  pending_stock_posting: "warning",
  held: "danger",
};

export function offlineSyncBadge(
  state: OfflineSyncState | null | undefined,
  mode: "list" | "detail" = "list",
) {
  if (!state) return null;
  const labels = mode === "list" ? SYNC_LIST_LABELS : SYNC_DETAIL_LABELS;
  return (
    <StatusBadge status={state} label={labels[state]} variant={SYNC_VARIANTS[state]} />
  );
}

const SALE_STATUS_LABELS: Record<SaleStatus, string> = {
  posted: "Completed",
  voided: "Voided",
  refunded: "Refunded",
  partially_refunded: "Partly refunded",
};

const SALE_STATUS_VARIANTS: Record<SaleStatus, BadgeVariant> = {
  posted: "success",
  voided: "danger",
  refunded: "info",
  partially_refunded: "info",
};

export function saleStatusBadge(status: SaleStatus) {
  return (
    <StatusBadge
      status={status}
      label={SALE_STATUS_LABELS[status]}
      variant={SALE_STATUS_VARIANTS[status]}
    />
  );
}

export function incidentNoteStatusBadge(status: string) {
  if (status === "held") {
    return <StatusBadge status="held" label="Held" variant="warning" />;
  }
  return <StatusBadge status="open" label="Open" variant="info" />;
}

export function unresolvedMoneyStatusBadge() {
  return <StatusBadge status="unresolved" label="Unresolved" variant="warning" />;
}

export function clearsOnUploadBadge(clears: boolean) {
  if (!clears) return null;
  return <StatusBadge status="clears_on_upload" label="Clears on upload" variant="info" />;
}