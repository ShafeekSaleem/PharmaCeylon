"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  IconAlertTriangle,
  IconBell,
  IconBox,
  IconCheck,
  IconClipboardList,
  IconPackage,
  IconTruck,
} from "@/components/icons";
import { useAuth } from "@/lib/use-auth";
import {
  fetchNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  relativeNotificationTime,
  type NotificationItem,
} from "@/lib/notifications-client";
import css from "./notifications.module.css";

function categoryIcon(item: NotificationItem) {
  const props = { size: 16 };
  if (item.severity === "critical") return <IconAlertTriangle {...props} />;
  switch (item.category) {
    case "inventory":
      return <IconPackage {...props} />;
    case "expiry":
      return <IconAlertTriangle {...props} />;
    case "purchasing":
      return <IconClipboardList {...props} />;
    case "transfers":
      return <IconTruck {...props} />;
    case "stocktakes":
      return <IconBox {...props} />;
    default:
      return <IconBell {...props} />;
  }
}

export function NotificationCenter() {
  const router = useRouter();
  const { branchId } = useAuth();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async (showSpinner = false) => {
    if (showSpinner) setLoading(true);
    try {
      const response = await fetchNotifications("take=6");
      setItems(response.items);
      setUnread(response.unread);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
    const interval = window.setInterval(() => void load(), 30_000);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [load, branchId]);

  useEffect(() => {
    function onOutside(event: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node))
        setOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, []);

  async function openItem(item: NotificationItem) {
    if (!item.readAt) {
      setItems((rows) =>
        rows.map((row) =>
          row.id === item.id
            ? { ...row, readAt: new Date().toISOString() }
            : row,
        ),
      );
      setUnread((value) => Math.max(0, value - 1));
      void markNotificationRead(item.id).catch(() => void load());
    }
    setOpen(false);
    if (item.actionHref) router.push(item.actionHref);
  }

  async function markAllRead() {
    if (unread === 0) return;
    const now = new Date().toISOString();
    setItems((rows) =>
      rows.map((row) => ({ ...row, readAt: row.readAt ?? now })),
    );
    setUnread(0);
    try {
      await markAllNotificationsRead();
    } catch {
      void load();
    }
  }

  return (
    <div className={css.centerWrap} ref={wrapRef}>
      <button
        type="button"
        className={`${css.bellButton}${open ? ` ${css.bellButtonActive}` : ""}`}
        aria-label={
          unread ? `Notifications, ${unread} unread` : "Notifications"
        }
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <IconBell size={20} />
        {unread ? (
          <span className={css.unreadBadge}>
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className={css.menu}>
          <header className={css.menuHeader}>
            <div>
              <strong>Notifications</strong>
              <span>
                {unread ? `${unread} unread` : "You’re all caught up"}
              </span>
            </div>
            <button type="button" onClick={markAllRead} disabled={!unread}>
              <IconCheck size={14} /> Mark all read
            </button>
          </header>

          <div className={css.menuBody}>
            {loading ? (
              <div className={css.menuState}>Loading notifications…</div>
            ) : null}
            {!loading && failed ? (
              <div className={css.menuState}>
                Couldn’t load notifications.
                <button type="button" onClick={() => void load(true)}>
                  Try again
                </button>
              </div>
            ) : null}
            {!loading && !failed && !items.length ? (
              <div className={css.emptyState}>
                <span>
                  <IconCheck size={20} />
                </span>
                <strong>No active notifications</strong>
                <small>
                  Operational alerts will appear here when something needs
                  attention.
                </small>
              </div>
            ) : null}
            {!loading && !failed
              ? items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`${css.menuItem}${!item.readAt ? ` ${css.menuItemUnread}` : ""}`}
                    onClick={() => void openItem(item)}
                  >
                    <span
                      className={`${css.itemIcon} ${css[`severity_${item.severity}`]}`}
                    >
                      {categoryIcon(item)}
                    </span>
                    <span className={css.itemCopy}>
                      <span className={css.itemTitle}>{item.title}</span>
                      {item.message ? (
                        <span className={css.itemMessage}>{item.message}</span>
                      ) : null}
                      <span className={css.itemMeta}>
                        {item.branch?.name ? `${item.branch.name} · ` : ""}
                        {relativeNotificationTime(item.updatedAt)}
                      </span>
                    </span>
                    {!item.readAt ? <span className={css.unreadDot} /> : null}
                  </button>
                ))
              : null}
          </div>

          <Link
            href="/notifications"
            className={css.viewAll}
            onClick={() => setOpen(false)}
          >
            View all notifications
          </Link>
        </div>
      ) : null}
    </div>
  );
}
