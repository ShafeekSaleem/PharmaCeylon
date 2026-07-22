import styles from "./status-badge.module.css";

export type BadgeVariant =
  | "default"
  | "primary"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "muted";

const STATUS_MAP: Record<string, BadgeVariant> = {
  active: "success",
  completed: "success",
  received: "success",
  approved: "success",
  paid: "success",
  draft: "muted",
  pending: "warning",
  pending_approval: "warning",
  requested: "warning",
  partially_received: "warning",
  in_transit: "info",
  issued: "info",
  processing: "info",
  shipped: "info",
  cancelled: "danger",
  voided: "danger",
  rejected: "danger",
  failed: "danger",
  refunded: "danger",
  inactive: "muted",
  expired: "danger",
  overdue: "danger",
};

const STATUS_LABELS: Record<string, string> = {
  requested: "Pending approval",
  approved: "Ready to ship",
  in_transit: "In transit",
  partially_received: "Partially received",
  overdue: "Overdue",
};

type Props = {
  status: string;
  variant?: BadgeVariant;
  dot?: boolean;
  className?: string;
};

export function StatusBadge({ status, variant, dot = false, className }: Props) {
  const resolved = variant ?? STATUS_MAP[status.toLowerCase()] ?? "default";
  const label = STATUS_LABELS[status.toLowerCase()] ?? status.replace(/_/g, " ");

  const cls = [
    styles.badge,
    styles[resolved],
    className ?? "",
  ].filter(Boolean).join(" ");

  return (
    <span className={cls}>
      {dot && <span className={styles.dot} />}
      {label}
    </span>
  );
}
