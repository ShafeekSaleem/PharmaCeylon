"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert } from "@/components/alert";
import {
  IconAlertTriangle,
  IconArchive,
  IconBell,
  IconBox,
  IconCheck,
  IconClipboardList,
  IconPackage,
  IconSearch,
  IconSettings,
  IconTruck,
} from "@/components/icons";
import { ActionButton, PageHeader, ToggleSwitch } from "@/components/ui";
import {
  archiveNotification,
  fetchNotificationPreferences,
  fetchNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  relativeNotificationTime,
  saveNotificationPreferences,
  type NotificationCategory,
  type NotificationItem,
  type NotificationPreferences,
  type NotificationsResponse,
} from "@/lib/notifications-client";
import { useBodyScrollLock } from "@/lib/use-body-scroll-lock";
import css from "./notifications-page.module.css";

type StatusFilter = "all" | "unread" | "action_required";

const CATEGORIES: Array<{
  value: NotificationCategory | "all";
  label: string;
}> = [
  { value: "all", label: "All categories" },
  { value: "inventory", label: "Inventory" },
  { value: "expiry", label: "Expiry" },
  { value: "purchasing", label: "Purchasing" },
  { value: "transfers", label: "Transfers" },
  { value: "stocktakes", label: "Stocktakes" },
  { value: "sales", label: "Sales" },
  { value: "compliance", label: "Compliance" },
  { value: "system", label: "System" },
];

const PREFERENCE_ROWS: Array<{
  key: keyof NotificationPreferences;
  label: string;
  hint: string;
}> = [
  {
    key: "inventoryEnabled",
    label: "Inventory",
    hint: "Low stock and stock-health warnings",
  },
  {
    key: "expiryEnabled",
    label: "Expiry",
    hint: "Near-expiry and expired batch warnings",
  },
  {
    key: "purchasingEnabled",
    label: "Purchasing",
    hint: "Approvals, overdue orders and receiving",
  },
  {
    key: "transfersEnabled",
    label: "Transfers",
    hint: "Approvals and incoming stock",
  },
  {
    key: "stocktakesEnabled",
    label: "Stocktakes",
    hint: "Reviews, approvals and posting",
  },
  { key: "salesEnabled", label: "Sales", hint: "Sale and counter exceptions" },
  {
    key: "complianceEnabled",
    label: "Compliance",
    hint: "Pharmacist and controlled medicine actions",
  },
  {
    key: "systemEnabled",
    label: "System",
    hint: "Import, synchronization and service failures",
  },
];

function iconFor(item: NotificationItem) {
  const props = { size: 18 };
  if (item.severity === "critical") return <IconAlertTriangle {...props} />;
  if (item.category === "inventory") return <IconPackage {...props} />;
  if (item.category === "expiry") return <IconAlertTriangle {...props} />;
  if (item.category === "purchasing") return <IconClipboardList {...props} />;
  if (item.category === "transfers") return <IconTruck {...props} />;
  if (item.category === "stocktakes") return <IconBox {...props} />;
  return <IconBell {...props} />;
}

export default function NotificationsPage() {
  const router = useRouter();
  const [status, setStatus] = useState<StatusFilter>("all");
  const [category, setCategory] = useState<NotificationCategory | "all">("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [data, setData] = useState<NotificationsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [preferences, setPreferences] =
    useState<NotificationPreferences | null>(null);
  const [savingPreferences, setSavingPreferences] = useState(false);
  useBodyScrollLock(preferencesOpen);

  useEffect(() => {
    const timer = window.setTimeout(
      () => setDebouncedSearch(search.trim()),
      220,
    );
    return () => window.clearTimeout(timer);
  }, [search]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ take: "100", status });
    if (category !== "all") params.set("category", category);
    if (debouncedSearch) params.set("q", debouncedSearch);
    try {
      setData(await fetchNotifications(params.toString()));
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Failed to load notifications",
      );
    } finally {
      setLoading(false);
    }
  }, [category, debouncedSearch, status]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!preferencesOpen || preferences) return;
    fetchNotificationPreferences()
      .then(setPreferences)
      .catch((reason) => {
        setError(
          reason instanceof Error
            ? reason.message
            : "Failed to load preferences",
        );
      });
  }, [preferences, preferencesOpen]);

  const rows = data?.items ?? [];
  const statusCounts = useMemo(
    () => ({
      all: data?.total ?? 0,
      unread: data?.unread ?? 0,
      action_required: data?.actionRequired ?? 0,
    }),
    [data],
  );

  async function openItem(item: NotificationItem) {
    if (!item.readAt) {
      await markNotificationRead(item.id).catch(() => undefined);
      setData((current) =>
        current
          ? {
              ...current,
              unread: Math.max(0, current.unread - 1),
              items: current.items.map((row) =>
                row.id === item.id
                  ? { ...row, readAt: new Date().toISOString() }
                  : row,
              ),
            }
          : current,
      );
    }
    if (item.actionHref) router.push(item.actionHref);
  }

  async function markAllRead() {
    try {
      await markAllNotificationsRead();
      const now = new Date().toISOString();
      setData((current) =>
        current
          ? {
              ...current,
              unread: 0,
              items: current.items.map((row) => ({
                ...row,
                readAt: row.readAt ?? now,
              })),
            }
          : current,
      );
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not mark notifications as read",
      );
    }
  }

  async function archive(item: NotificationItem) {
    try {
      await archiveNotification(item.id);
      setData((current) =>
        current
          ? {
              ...current,
              total: Math.max(0, current.total - 1),
              unread: item.readAt
                ? current.unread
                : Math.max(0, current.unread - 1),
              actionRequired: item.requiresAction
                ? Math.max(0, current.actionRequired - 1)
                : current.actionRequired,
              items: current.items.filter((row) => row.id !== item.id),
            }
          : current,
      );
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not archive notification",
      );
    }
  }

  async function savePreferences() {
    if (!preferences) return;
    setSavingPreferences(true);
    try {
      setPreferences(await saveNotificationPreferences(preferences));
      setPreferencesOpen(false);
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Could not save preferences",
      );
    } finally {
      setSavingPreferences(false);
    }
  }

  return (
    <div className={css.page}>
      <PageHeader
        title="Notifications"
        description="Operational alerts and actions for your current branch."
        actions={
          <div className={css.headerActions}>
            <ActionButton
              variant="secondary"
              onClick={() => setPreferencesOpen(true)}
            >
              <IconSettings size={15} /> Preferences
            </ActionButton>
            <ActionButton
              variant="secondary"
              onClick={() => void markAllRead()}
              disabled={!data?.unread}
            >
              <IconCheck size={15} /> Mark all read
            </ActionButton>
          </div>
        }
      />

      {error ? <Alert variant="error">{error}</Alert> : null}

      <div className={css.filterCard}>
        <div
          className={css.statusTabs}
          role="tablist"
          aria-label="Notification status"
        >
          {(["all", "unread", "action_required"] as StatusFilter[]).map(
            (value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={status === value}
                className={status === value ? css.statusTabActive : undefined}
                onClick={() => setStatus(value)}
              >
                {value === "all"
                  ? "All"
                  : value === "unread"
                    ? "Unread"
                    : "Action required"}
                <span>{statusCounts[value]}</span>
              </button>
            ),
          )}
        </div>
        <div className={css.filtersRight}>
          <label className={css.searchField}>
            <IconSearch size={15} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search notifications"
            />
          </label>
          <select
            value={category}
            onChange={(event) =>
              setCategory(event.target.value as NotificationCategory | "all")
            }
          >
            {CATEGORIES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <section className={css.list} aria-busy={loading}>
        {loading ? (
          <div className={css.state}>Loading notifications…</div>
        ) : null}
        {!loading && !rows.length ? (
          <div className={css.empty}>
            <span>
              <IconCheck size={24} />
            </span>
            <h2>No matching notifications</h2>
            <p>
              When an operational issue needs your attention, it will appear
              here.
            </p>
          </div>
        ) : null}
        {!loading
          ? rows.map((item) => (
              <article
                key={item.id}
                className={`${css.item}${!item.readAt ? ` ${css.itemUnread}` : ""}`}
              >
                <span
                  className={`${css.itemIcon} ${css[`severity_${item.severity}`]}`}
                >
                  {iconFor(item)}
                </span>
                <button
                  type="button"
                  className={css.itemMain}
                  onClick={() => void openItem(item)}
                >
                  <span className={css.itemTopline}>
                    <strong>{item.title}</strong>
                    {!item.readAt ? (
                      <span className={css.unreadPill}>New</span>
                    ) : null}
                    {item.requiresAction ? (
                      <span className={css.actionPill}>Action required</span>
                    ) : null}
                  </span>
                  {item.message ? (
                    <span className={css.message}>{item.message}</span>
                  ) : null}
                  <span className={css.meta}>
                    <span className={css.category}>{item.category}</span>
                    {item.branch?.name ? <span>{item.branch.name}</span> : null}
                    <span>{relativeNotificationTime(item.updatedAt)}</span>
                  </span>
                </button>
                <div className={css.itemActions}>
                  {item.actionHref ? (
                    <button
                      type="button"
                      className={css.primaryAction}
                      onClick={() => void openItem(item)}
                    >
                      {item.actionLabel ?? "Open"}
                    </button>
                  ) : null}
                  {!item.readAt ? (
                    <button
                      type="button"
                      aria-label="Mark as read"
                      title="Mark as read"
                      onClick={() =>
                        void markNotificationRead(item.id).then(load)
                      }
                    >
                      <IconCheck size={16} />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    aria-label="Archive"
                    title="Archive"
                    onClick={() => void archive(item)}
                  >
                    <IconArchive size={16} />
                  </button>
                </div>
              </article>
            ))
          : null}
      </section>

      {preferencesOpen ? (
        <div
          className={css.modalBackdrop}
          onMouseDown={() => setPreferencesOpen(false)}
        >
          <section
            className={css.preferencesPanel}
            role="dialog"
            aria-modal="true"
            aria-label="Notification preferences"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <h2>Notification preferences</h2>
                <p>Choose which operational categories appear in your inbox.</p>
              </div>
              <button
                type="button"
                onClick={() => setPreferencesOpen(false)}
                aria-label="Close"
              >
                ×
              </button>
            </header>
            <div className={css.preferenceRows}>
              {!preferences ? (
                <div className={css.state}>Loading preferences…</div>
              ) : (
                PREFERENCE_ROWS.map((row) => (
                  <div key={row.key} className={css.preferenceRow}>
                    <div>
                      <strong>{row.label}</strong>
                      <span>{row.hint}</span>
                    </div>
                    <ToggleSwitch
                      checked={preferences[row.key]}
                      label={`${row.label} notifications`}
                      onChange={(checked) =>
                        setPreferences({ ...preferences, [row.key]: checked })
                      }
                    />
                  </div>
                ))
              )}
            </div>
            <footer>
              <ActionButton
                variant="secondary"
                onClick={() => setPreferencesOpen(false)}
              >
                Cancel
              </ActionButton>
              <ActionButton
                onClick={() => void savePreferences()}
                disabled={!preferences || savingPreferences}
              >
                {savingPreferences ? "Saving…" : "Save preferences"}
              </ActionButton>
            </footer>
          </section>
        </div>
      ) : null}
    </div>
  );
}
