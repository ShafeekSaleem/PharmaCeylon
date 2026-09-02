"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert } from "@/components/alert";
import { IconActivity, IconAlertTriangle, IconCheck, IconChevronDown, IconInfo, IconRefresh } from "@/components/icons";
import { useRoleAccess } from "@/lib/use-role-access";
import type { Scope } from "@/app/(app)/reports/lib/types";
import { useDashboardData, type OwnerAnalyticsScope } from "../dashboard/hooks/use-dashboard-data";
import { resolvePrimaryDashboardRole } from "../dashboard/lib/dashboard-role";
import { buildCashierInsights, buildManagerInsights, buildOwnerInsights } from "../dashboard/lib/insight-builders";
import {
  INVENTORY_AI_INSIGHTS,
  PHARMACIST_AI_INSIGHTS,
  type AiInsight,
  type AiInsightCategory,
} from "../dashboard/lib/placeholder-data";
import { useReportSourcedInsights } from "./hooks/use-report-sourced-insights";
import css from "./insights.module.css";

const CATEGORY_LABEL: Record<AiInsightCategory, string> = {
  sales: "Sales",
  profitability: "Profitability",
  inventory: "Inventory",
  purchasing: "Purchasing",
  operations: "Operations",
  clinical: "Clinical",
};
const CATEGORY_ORDER: AiInsightCategory[] = ["inventory", "purchasing", "sales", "profitability", "clinical", "operations"];

type Tone = NonNullable<AiInsight["tone"]>;
const TONE_OPTIONS: { value: "all" | Tone; label: string }[] = [
  { value: "all", label: "All severities" },
  { value: "danger", label: "Danger" },
  { value: "warning", label: "Warning" },
  { value: "info", label: "Info" },
  { value: "success", label: "Success" },
];

const SCOPE_OPTIONS: DropdownOption<OwnerAnalyticsScope>[] = [
  { value: "all_branches", label: "All branches" },
  { value: "this_branch", label: "This branch" },
];

function toneIcon(tone: Tone) {
  const props = { size: 18 };
  if (tone === "warning" || tone === "danger") return <IconAlertTriangle {...props} />;
  if (tone === "success") return <IconActivity {...props} />;
  return <IconInfo {...props} />;
}

type DropdownOption<T extends string> = { value: T; label: string };

/** Compact themed replacement for a native `<select>` — mirrors the notifications page's own
 *  category filter so this page reads as the same kind of lightweight utility list. */
function Dropdown<T extends string>({
  value,
  options,
  onChange,
  "aria-label": ariaLabel,
}: {
  value: T;
  options: DropdownOption<T>[];
  onChange: (value: T) => void;
  "aria-label": string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    function onOutside(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
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
    <div className={css.dropdown} ref={ref}>
      <button
        type="button"
        className={`${css.dropdownTrigger}${open ? ` ${css.dropdownTriggerOpen}` : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{selected?.label ?? ariaLabel}</span>
        <IconChevronDown size={14} className={css.dropdownChevron} />
      </button>
      {open ? (
        <ul className={css.dropdownMenu} role="listbox">
          {options.map((option) => (
            <li
              key={option.value}
              role="option"
              aria-selected={option.value === value}
              className={`${css.dropdownOption}${option.value === value ? ` ${css.dropdownOptionActive}` : ""}`}
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

export default function InsightsPage() {
  const router = useRouter();
  const { userRoles } = useRoleAccess();
  const data = useDashboardData();
  const viewRole = useMemo(() => resolvePrimaryDashboardRole(userRoles), [userRoles]);
  const isOwner = viewRole === "owner";

  const roleInsights: AiInsight[] = useMemo(() => {
    switch (viewRole) {
      case "owner":
        return buildOwnerInsights(data);
      case "manager":
        return buildManagerInsights(data);
      case "cashier":
        return buildCashierInsights(data);
      case "pharmacist":
        return PHARMACIST_AI_INSIGHTS;
      case "inventory_clerk":
        return INVENTORY_AI_INSIGHTS;
      default:
        return [];
    }
  }, [viewRole, data]);

  const reportScope: Scope = isOwner && data.ownerScope === "all_branches" ? "tenant" : "branch";
  const { items: reportItems, loading: reportLoading } = useReportSourcedInsights(
    data.canViewReports,
    reportScope,
    isOwner,
  );

  const allItems = useMemo(() => [...roleInsights, ...reportItems], [roleInsights, reportItems]);
  const loading = data.loading || reportLoading;

  const [categoryFilter, setCategoryFilter] = useState<"all" | AiInsightCategory>("all");
  const [toneFilter, setToneFilter] = useState<"all" | Tone>("all");

  const availableCategories = useMemo(() => {
    const present = new Set(allItems.map((i) => i.category));
    return CATEGORY_ORDER.filter((c) => present.has(c));
  }, [allItems]);

  // A branch switch (or role change) can make the selected category disappear — fall back to
  // "all" rather than silently keep filtering by a category with nothing in it.
  useEffect(() => {
    if (categoryFilter !== "all" && !availableCategories.includes(categoryFilter)) {
      setCategoryFilter("all");
    }
  }, [availableCategories, categoryFilter]);

  const categoryTabs = useMemo(
    () => [
      { value: "all" as const, label: "All", count: allItems.length },
      ...availableCategories.map((c) => ({
        value: c,
        label: CATEGORY_LABEL[c],
        count: allItems.filter((i) => i.category === c).length,
      })),
    ],
    [allItems, availableCategories],
  );

  const filteredItems = useMemo(
    () =>
      allItems.filter(
        (i) =>
          (categoryFilter === "all" || i.category === categoryFilter) &&
          (toneFilter === "all" || (i.tone ?? "info") === toneFilter),
      ),
    [allItems, categoryFilter, toneFilter],
  );

  return (
    <div className={css.page}>
      {!data.branchId ? <Alert variant="warning">Select a branch in the header to load insights.</Alert> : null}
      {data.error ? <Alert variant="error">{data.error}</Alert> : null}

      <div className={css.filterCard}>
        <div className={css.categoryTabs} role="tablist" aria-label="Insight category">
          {categoryTabs.map((tab) => (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={categoryFilter === tab.value}
              className={categoryFilter === tab.value ? css.categoryTabActive : undefined}
              onClick={() => setCategoryFilter(tab.value)}
            >
              {tab.label}
              <span>{tab.count}</span>
            </button>
          ))}
        </div>
        <div className={css.filtersRight}>
          <Dropdown aria-label="Severity" value={toneFilter} options={TONE_OPTIONS} onChange={setToneFilter} />
          {isOwner ? (
            <Dropdown aria-label="Branch scope" value={data.ownerScope} options={SCOPE_OPTIONS} onChange={data.setOwnerScope} />
          ) : null}
          <button
            type="button"
            className={css.refreshBtn}
            aria-label="Refresh insights"
            data-tooltip="Refresh"
            onClick={() => void data.reload()}
          >
            <IconRefresh size={15} />
          </button>
        </div>
      </div>

      <section className={css.list} aria-busy={loading}>
        {loading && allItems.length === 0 ? <div className={css.state}>Loading insights…</div> : null}
        {!loading && !filteredItems.length ? (
          <div className={css.empty}>
            <span>
              <IconCheck size={24} />
            </span>
            <h2>Nothing needs attention right now</h2>
            <p>New insights will appear here as they come up.</p>
          </div>
        ) : null}
        {filteredItems.map((item) => {
          const tone: Tone = item.tone ?? "info";
          const countText = item.countText ?? (item.count != null && item.countLabel ? `${item.count} ${item.countLabel}` : null);
          const body = (
            <>
              <span className={css.itemTopline}>
                <strong>{item.title}</strong>
                {item.sample ? <span className={css.sampleTag}>Sample</span> : null}
              </span>
              <span className={css.message}>{item.detail}</span>
              {item.examples && item.examples.length > 0 ? (
                <span className={css.examplesRow}>
                  {item.examples.map((ex, i) => (
                    <span key={i} className={css.exampleChip}>
                      {ex.label}
                      {ex.badge ? <b>{ex.badge}</b> : null}
                    </span>
                  ))}
                </span>
              ) : null}
              <span className={css.meta}>
                <span className={css.category}>{CATEGORY_LABEL[item.category]}</span>
              </span>
            </>
          );
          return (
            <article key={item.id} className={css.item}>
              <span className={`${css.itemIcon} ${css[`severity_${tone}`]}`}>{toneIcon(tone)}</span>
              {item.href ? (
                <button type="button" className={css.itemMain} onClick={() => router.push(item.href!)}>
                  {body}
                </button>
              ) : (
                <div className={`${css.itemMain} ${css.itemMainStatic}`}>{body}</div>
              )}
              <div className={css.itemActions}>
                {countText ? <span className={`${css.countPill} ${css[`severity_${tone}`]}`}>{countText}</span> : null}
                {item.href ? (
                  <button type="button" className={css.primaryAction} onClick={() => router.push(item.href!)}>
                    {item.actionLabel ?? "Open"}
                  </button>
                ) : null}
              </div>
            </article>
          );
        })}
      </section>
    </div>
  );
}
