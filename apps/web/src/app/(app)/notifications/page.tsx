"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert } from "@/components/alert";
import {
  IconAlertTriangle,
  IconArchive,
  IconBell,
  IconBox,
  IconCheck,
  IconChevronDown,
  IconClipboardList,
  IconPackage,
  IconSearch,
  IconSettings,
  IconTruck,
} from "@/components/icons";
import { ActionButton, PageHeader } from "@/components/ui";
import actionCss from "@/components/ui/page-header.module.css";
import { usePermissions } from "@/lib/permissions";
import {
  archiveNotification,
  fetchNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  relativeNotificationTime,
  type NotificationCategory,
  type NotificationItem,
  type NotificationsResponse,
} from "@/lib/notifications-client";
import css from "./notifications-page.module.css";

type StatusFilter = "all" | "unread" | "action_required";

/** Same set as settings/notifications' PREFERENCE_ROWS — only categories the backend can
 *  actually generate, each gated behind the permission the API checks before generating it, so
 *  the filter never offers a category this role could never have a notification in. */
const CATEGORIES: Array<{
  value: NotificationCategory | "all";
  label: string;
  permission?: string;
}> = [
  { value: "all", label: "All categories" },
  { value: "inventory", label: "Inventory", permission: "inventory.view" },
  { value: "expiry", label: "Expiry", permission: "inventory.view" },
  { value: "purchasing", label: "Purchasing", permission: "purchasing.view" },
  { value: "transfers", label: "Transfers", permission: "transfers.view" },
  { value: "stocktakes", label: "Stocktakes", permission: "stocktakes.use" },
  { value: "compliance", label: "Access & Approvals", permission: "users.view" },
  { value: "system", label: "Branch & Tenant", permission: "tenant.management" },
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

type CategoryOption = { value: NotificationCategory | "all"; label: string };

/** Compact themed replacement for a native `<select>` — a native popup falls back to OS
 *  chrome that can't be styled to match the app's light/dense/appearance system. */
function CategoryFilter({
  value,
  options,
  onChange,
}: {
  value: NotificationCategory | "all";
  options: CategoryOption[];
  onChange: (value: NotificationCategory | "all") => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    if (!open) return;
    function onOutside(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node))
        setOpen(false);
    }
    function onEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onOutside);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open]);

  return (
    <div className={css.categoryFilter} ref={ref}>
      <button
        type="button"
        className={`${css.categoryTrigger}${open ? ` ${css.categoryTriggerOpen}` : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{selected?.label ?? "All categories"}</span>
        <IconChevronDown size={14} className={css.categoryChevron} />
      </button>
      {open ? (
        <ul className={css.categoryMenu} role="listbox">
          {options.map((option) => (
            <li
              key={option.value}
              role="option"
              aria-selected={option.value === value}
              className={`${css.categoryOption}${option.value === value ? ` ${css.categoryOptionActive}` : ""}`}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              <span>{option.label}</span>
              {option.value === value ? <IconCheck size={13} /> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export default function NotificationsPage() {
  const router = useRouter();
  const { permissionKeys } = usePermissions();
  const availableCategories = useMemo(
    () =>
      CATEGORIES.filter(
        (option) => !option.permission || permissionKeys.includes(option.permission),
      ),
    [permissionKeys],
  );
  const [status, setStatus] = useState<StatusFilter>("all");
  const [category, setCategory] = useState<NotificationCategory | "all">("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [data, setData] = useState<NotificationsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(
      () => setDebouncedSearch(search.trim()),
      220,
    );
    return () => window.clearTimeout(timer);
  }, [search]);

  // A branch switch can change granted permissions — if the selected category filter is no
  // longer offered, fall back to "all" rather than silently keep filtering by it.
  useEffect(() => {
    if (!availableCategories.some((option) => option.value === category)) {
      setCategory("all");
    }
  }, [availableCategories, category]);

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

  return (
    <div className={css.page}>
      <PageHeader
        title="Notifications"
        description="Operational alerts and actions for your current branch."
        actions={
          <div className={css.headerActions}>
            <Link
              href="/settings/notifications"
              className={`${actionCss.actionBtn} ${actionCss.actionSecondary}`}
            >
              <IconSettings size={15} /> Preferences
            </Link>
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
          <CategoryFilter value={category} options={availableCategories} onChange={setCategory} />
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
                      data-tooltip="Mark as read"
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
                    data-tooltip="Archive"
                    onClick={() => void archive(item)}
                  >
                    <IconArchive size={16} />
                  </button>
                </div>
              </article>
            ))
          : null}
      </section>
    </div>
  );
}
