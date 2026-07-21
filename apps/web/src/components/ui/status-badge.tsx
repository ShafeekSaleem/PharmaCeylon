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

type Props = {
  status: string;
  variant?: BadgeVariant;
  dot?: boolean;
  className?: string;
};

export function StatusBadge({ status, variant, dot = false, className }: Props) {
  const resolved = variant ?? STATUS_MAP[status.toLowerCase()] ?? "default";
  const label = status.replace(/_/g, " ");

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
