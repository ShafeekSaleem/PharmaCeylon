"use client";

import Link from "next/link";
import type {
  DailyWorkItem,
  WorkCategory,
  WorkFilter,
} from "@pharmaceylon/shared";
import { IconChevronRight, IconCheck, IconRefresh } from "@/components/icons";
import { usePermissions } from "@/lib/permissions";
import { useDailyWork } from "../hooks/use-daily-work";
import type { DashboardRole } from "../lib/dashboard-role";
import css from "./daily-work.module.css";

const ROLE_COPY: Record<
  DashboardRole,
  {
    title: string;
    detail: string;
    action: string;
    href: string;
    permission: string;
  }
> = {
  owner: {
    title: "Keep your business moving",
    detail: "Decisions and follow-ups for your active branch.",
    action: "Open purchasing",
    href: "/purchasing",
    permission: "purchasing.view",
  },
  manager: {
    title: "Make today run smoothly",
    detail: "See what needs a decision and help your team keep moving.",
    action: "Open stocktakes",
    href: "/stocktakes",
    permission: "stocktakes.use",
  },
  pharmacist: {
    title: "A clear view of your counter",
    detail: "Review flagged holds and keep stock safe to dispense.",
    action: "Open pharmacist holds",
    href: "/pos?panel=holds",
    permission: "sales.pos_use",
  },
  cashier: {
    title: "Ready for your next customer",
    detail: "Pick up a held bill or head straight to the till.",
    action: "Open POS",
    href: "/pos",
    permission: "sales.pos_use",
  },
  inventory_clerk: {
    title: "Your stock work, in order",
    detail: "Continue counts, receive deliveries and resolve stock exceptions.",
    action: "Open receiving",
    href: "/purchasing",
    permission: "purchasing.receive",
  },
};
const CATEGORY_LABELS: Record<WorkCategory, string> = {
  purchasing: "Purchasing",
  transfers: "Transfers",
  returns: "Supplier returns",
  stocktakes: "Stocktakes",
  counter: "Counter",
  inventory: "Stock safety",
};
const FILTERS: Array<{ key: WorkFilter; label: string }> = [
  { key: "all", label: "All work" },
  { key: "mine", label: "Assigned to me" },
  { key: "approvals", label: "Needs my decision" },
  { key: "overdue", label: "Overdue" },
];

export function workTiming(
  item: DailyWorkItem,
  timezone: string,
  asOf: string,
): string {
  if (!item.dueAt) {
    const minutes = Math.max(
      0,
      Math.floor(
        (new Date(asOf).getTime() - new Date(item.createdAt).getTime()) /
          60_000,
      ),
    );
    if (item.category === "counter")
      return minutes < 1
        ? "Just held"
        : minutes < 60
          ? `${minutes} min waiting`
          : `${Math.floor(minutes / 60)}h ${minutes % 60}m waiting`;
    return `Opened ${new Date(item.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: timezone })}`;
  }
  return `${item.overdue ? "Overdue · " : "Due "}${new Date(item.dueAt).toLocaleString("en-GB", { day: "numeric", month: "short", ...(item.category === "stocktakes" ? ({ hour: "2-digit", minute: "2-digit" } as const) : {}), timeZone: timezone })}`;
}

export function DailyWorkQueue({
  role,
  branchId,
  refreshKey,
}: {
  role: DashboardRole;
  branchId: string | null;
  refreshKey: string | null;
}) {
  const work = useDailyWork(branchId, refreshKey);
  const { permissionKeys } = usePermissions();
  const copy = ROLE_COPY[role];
  const { data, error, loading } = work;
  const categories = Object.entries(data?.categories ?? {}) as Array<
    [WorkCategory, number]
  >;
  const total = categories.reduce((sum, [, count]) => sum + count, 0);
  const first = data?.items.find((item) => !item.blocked);
  const date = new Date(data?.asOf ?? Date.now()).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: data?.timezone ?? "Asia/Colombo",
  });

  return (
    <section className={css.workspace} aria-labelledby="daily-work-title">
      <header className={css.intro}>
        <div>
          <div className={css.eyebrow}>
            YOUR DAILY WORKSPACE <span>·</span> {date}
          </div>
          <h1 id="daily-work-title">{copy.title}</h1>
          <p>{copy.detail}</p>
        </div>
        {permissionKeys.includes(copy.permission) ? (
          <Link href={copy.href} className={css.primary}>
            {copy.action}
            <IconChevronRight size={16} />
          </Link>
        ) : null}
      </header>

      <div className={css.body}>
        <div className={css.queue}>
          <div className={css.queueHeader}>
            <div>
              <h2>Today’s priorities</h2>
              <p>
                {data?.branchName ?? "Active branch"} · Relevant work, including
                carry-over and upcoming counts
              </p>
            </div>
            <button
              className={css.refresh}
              type="button"
              aria-label="Refresh work queue"
              disabled={loading}
              onClick={work.reload}
            >
              <IconRefresh size={16} />
            </button>
          </div>
          <div className={css.controls}>
            <div
              className={css.filters}
              role="group"
              aria-label="Filter daily work"
            >
              {FILTERS.map(({ key, label }) => (
                <button
                  type="button"
                  key={key}
                  aria-pressed={work.filter === key}
                  onClick={() => work.selectFilter(key)}
                >
                  {label}
                  <span>{data?.counts[key] ?? "—"}</span>
                </button>
              ))}
            </div>
            <label className={css.category}>
              <span className={css.srOnly}>Work category</span>
              <select
                value={work.category}
                onChange={(e) =>
                  work.selectCategory(e.target.value as WorkCategory | "")
                }
              >
                <option value="">All categories</option>
                {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {error ? (
            <div className={css.error} role="alert">
              <strong>Work queue unavailable</strong>
              <p>{error}</p>
              <button type="button" onClick={work.reload}>
                Try again
              </button>
              <p>
                Tasks may still need attention. Open the relevant operation to
                check.
              </p>
            </div>
          ) : null}
          {loading && !data ? (
            <div className={css.skeleton} role="status">
              Loading your priorities…
              {[0, 1, 2, 3].map((n) => (
                <div key={n} />
              ))}
            </div>
          ) : null}
          {!error && data ? (
            <>
              <div className={css.rows} aria-busy={loading}>
                {data.items.map((item) => (
                  <article
                    key={item.id}
                    className={`${css.row} ${item.overdue || item.priority === 0 ? css.urgent : ""}`}
                  >
                    <div className={css.marker} aria-hidden>
                      {item.approval
                        ? "!"
                        : item.category === "counter"
                          ? "↗"
                          : "•"}
                    </div>
                    <div className={css.task}>
                      <div className={css.taskTitle}>
                        <h3>{item.title}</h3>
                        <span className={css.reference}>{item.reference}</span>
                        <span className={css.status}>
                          {item.status.replace(/_/g, " ")}
                        </span>
                      </div>
                      <p>{item.detail.replace(/_/g, " ")}</p>
                      <div className={css.meta}>
                        <span>{CATEGORY_LABELS[item.category]}</span>
                        <span>{item.mine ? "You" : item.owner}</span>
                        <span className={item.overdue ? css.overdue : ""}>
                          {workTiming(item, data.timezone, data.asOf)}
                        </span>
                      </div>
                      {item.blocked ? (
                        <p className={css.blocked}>
                          Your request needs another approver.
                        </p>
                      ) : null}
                    </div>
                    <Link
                      className={css.taskAction}
                      href={item.href}
                      aria-label={`${item.action}: ${item.reference}`}
                    >
                      {item.action}
                      <IconChevronRight size={14} />
                    </Link>
                  </article>
                ))}
                {data.items.length === 0 ? (
                  <div className={css.empty}>
                    <IconCheck size={25} />
                    <strong>
                      {work.filter === "all" && !work.category
                        ? "You’re up to date"
                        : "No work matches this view"}
                    </strong>
                    <p>
                      {work.filter === "mine"
                        ? "Shared team work is listed under All work."
                        : "New and unfinished work will appear here automatically."}
                    </p>
                    {work.filter !== "all" || work.category ? (
                      <button
                        type="button"
                        onClick={() => {
                          work.selectFilter("all");
                          work.selectCategory("");
                        }}
                      >
                        Show all work
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <footer className={css.footer}>
                <span role="status">
                  {loading
                    ? "Updating…"
                    : `${data.total ? (data.page - 1) * data.pageSize + 1 : 0}–${Math.min(data.page * data.pageSize, data.total)} of ${data.total} tasks`}
                </span>
                <div>
                  <button
                    type="button"
                    disabled={loading || data.page <= 1}
                    onClick={() => work.setPage(data.page - 1)}
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    disabled={
                      loading || data.page * data.pageSize >= data.total
                    }
                    onClick={() => work.setPage(data.page + 1)}
                  >
                    Next
                  </button>
                </div>
              </footer>
            </>
          ) : null}
        </div>

        <aside className={css.aside} aria-label="Daily workload summary">
          <div className={css.summary}>
            <span className={css.eyebrow}>WORKLOAD AT A GLANCE</span>
            <div className={css.total}>
              {error || !data ? "—" : total}
              <span>tasks available to you</span>
            </div>
            {error ? (
              <p>Summary unavailable</p>
            ) : categories.length ? (
              <div className={css.bars}>
                {categories.map(([category, count]) => (
                  <button
                    type="button"
                    key={category}
                    onClick={() => {
                      work.selectFilter("all");
                      work.selectCategory(category);
                    }}
                  >
                    <span>
                      {CATEGORY_LABELS[category]}
                      <strong>{count}</strong>
                    </span>
                    <i>
                      <b
                        style={{
                          width: `${Math.max(4, (count / total) * 100)}%`,
                        }}
                      />
                    </i>
                  </button>
                ))}
              </div>
            ) : (
              <p className={css.note}>
                A clear view of what needs attention, without a separate
                checklist to maintain.
              </p>
            )}
          </div>
          {!error && first ? (
            <div className={css.next}>
              <span className={css.eyebrow}>NEXT IN THIS VIEW</span>
              <h3>{first.title}</h3>
              <p>
                {first.reference} · {first.detail.replace(/_/g, " ")}
              </p>
              <Link href={first.href}>
                {first.action}
                <IconChevronRight size={15} />
              </Link>
            </div>
          ) : null}
          <p className={css.note}>
            Tasks clear when their workflow is completed. Shared work stays
            visible to the team. Updates every minute while this page is
            visible.
          </p>
        </aside>
      </div>
    </section>
  );
}
