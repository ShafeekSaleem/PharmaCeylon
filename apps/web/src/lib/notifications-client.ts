import { apiJson } from "./auth-client";

export type NotificationCategory =
  | "inventory"
  | "expiry"
  | "purchasing"
  | "transfers"
  | "stocktakes"
  | "sales"
  | "compliance"
  | "system";

export type NotificationItem = {
  id: string;
  branchId: string | null;
  category: NotificationCategory;
  severity: "info" | "warning" | "critical";
  title: string;
  message: string | null;
  actionLabel: string | null;
  actionHref: string | null;
  requiresAction: boolean;
  readAt: string | null;
  createdAt: string;
  updatedAt: string;
  branch: { id: string; name: string; code: string } | null;
};

export type NotificationsResponse = {
  items: NotificationItem[];
  filteredTotal: number;
  total: number;
  unread: number;
  actionRequired: number;
  skip: number;
  take: number;
};

export type NotificationPreferences = {
  inventoryEnabled: boolean;
  expiryEnabled: boolean;
  purchasingEnabled: boolean;
  transfersEnabled: boolean;
  stocktakesEnabled: boolean;
  salesEnabled: boolean;
  complianceEnabled: boolean;
  systemEnabled: boolean;
};

export function fetchNotifications(query = "take=30") {
  return apiJson<NotificationsResponse>(`/notifications?${query}`);
}

export function fetchUnreadCount() {
  return apiJson<{ unread: number }>("/notifications/unread-count");
}

export function markNotificationRead(id: string) {
  return apiJson<NotificationItem>(`/notifications/${id}/read`, {
    method: "PATCH",
    body: "{}",
  });
}

export function markAllNotificationsRead() {
  return apiJson<{ updated: number }>("/notifications/read-all", {
    method: "PATCH",
    body: "{}",
  });
}

export function archiveNotification(id: string) {
  return apiJson<NotificationItem>(`/notifications/${id}/archive`, {
    method: "PATCH",
    body: "{}",
  });
}

export function fetchNotificationPreferences() {
  return apiJson<NotificationPreferences>("/notifications/preferences");
}

export function saveNotificationPreferences(
  preferences: NotificationPreferences,
) {
  return apiJson<NotificationPreferences>("/notifications/preferences", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(preferences),
  });
}

export function relativeNotificationTime(value: string) {
  const elapsed = Date.now() - new Date(value).getTime();
  const minutes = Math.max(0, Math.floor(elapsed / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Intl.DateTimeFormat("en-LK", {
    day: "numeric",
    month: "short",
  }).format(new Date(value));
}
