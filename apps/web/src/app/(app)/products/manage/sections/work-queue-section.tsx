"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert } from "@/components/alert";
import {
  IconAlertTriangle,
  IconCheck,
  IconCheckCircle,
  IconGrid,
  IconSearch,
  IconX,
} from "@/components/icons";
import {
  ActionButton,
  DataTable,
  RowMenu,
  SelectField,
  type Column,
  type SelectFieldOption,
} from "@/components/ui";
import { usePermissions } from "@/lib/permissions";
import {
  applyCatalogTask,
  applySafeCatalogTasks,
  closeCatalogTask,
  fetchCatalogTasks,
  refreshCatalogTasks,
  type CatalogTask,
  type CatalogTaskQuery,
  type CatalogTaskSummary,
  type CategorySuggestion,
  type ReferenceSuggestion,
} from "../../api/catalog-tasks";
import { useProductMeta } from "../../hooks/use-product-meta";
import { ProductNmraLinkModal } from "../../components/product-nmra-link-modal";
import css from "../manage.module.css";

const PAGE_SIZE = 50;

/** The cross-cutting views the filter chips offer, in the order they are shown. */
const VIEWS = [
  { id: "all", label: "All tasks" },
  { id: "needs_category", label: "Needs category" },
  { id: "nmra_match", label: "NMRA match" },
  { id: "compliance", label: "Compliance review" },
  { id: "ambiguous", label: "Duplicate / ambiguous" },
  { id: "no_suggestion", label: "No suggestion" },
] as const;

type ViewId = (typeof VIEWS)[number]["id"];

const STATUS_VIEWS = [
  { id: "open", label: "Open" },
  { id: "resolved", label: "Resolved" },
  { id: "dismissed", label: "Dismissed" },
  { id: "not_applicable", label: "Not applicable" },
] as const;

type StatusViewId = (typeof STATUS_VIEWS)[number]["id"];

/** Closed-status wording. "NOT_APPLICABLE".toLowerCase() is not a sentence. */
const STATUS_LABELS: Record<string, string> = {
  OPEN: "Open",
  NEEDS_REVIEW: "Needs review",
  RESOLVED: "Resolved",
  DISMISSED: "Dismissed",
  NOT_APPLICABLE: "Not applicable",
};

/** A view id maps onto the API's `type` / `view` filters — the API has no compound "view" enum. */
function toQuery(
  view: ViewId,
  statusView: StatusViewId,
  q: string,
  importId: string | null,
  page: number,
): CatalogTaskQuery {
  const base: CatalogTaskQuery = {
    q: q.trim() || undefined,
    importId: importId ?? undefined,
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
  };

  switch (statusView) {
    case "resolved":
      base.status = ["RESOLVED"];
      break;
    case "dismissed":
      base.status = ["DISMISSED"];
      break;
    case "not_applicable":
      base.status = ["NOT_APPLICABLE"];
      break;
    default:
      base.status = ["OPEN", "NEEDS_REVIEW"];
  }

  switch (view) {
    case "needs_category":
      base.type = ["MISSING_CATEGORY"];
      break;
    case "nmra_match":
      base.type = ["NMRA_MATCH"];
      break;
    case "compliance":
      base.view = "compliance";
      break;
    case "ambiguous":
      base.view = "ambiguous";
      break;
    case "no_suggestion":
      base.view = "no_suggestion";
      break;
    default:
      break;
  }
  return base;
}

function isCategorySuggestion(
  suggestion: CatalogTask["suggestion"],
): suggestion is CategorySuggestion {
  return suggestion !== null && "categoryId" in suggestion;
}

function isReferenceSuggestion(
  suggestion: CatalogTask["suggestion"],
): suggestion is ReferenceSuggestion {
  return suggestion !== null && "referenceProductId" in suggestion;
}

/**
 * The Work Queue: every catalog decision waiting on a person, in one filterable, paginated
 * table.
 *
 * Replaces the Organize and Register-matches screens, which split the same job across two
 * pages by *how the answer was computed* rather than by anything a pharmacist cares about —
 * and, because neither persisted a decision, could only ever show the same list again. Both
 * also showed the first fifty rows with no way to reach the rest.
 */
export function WorkQueueSection({
  summary,
  onSummaryChange,
  importId,
  onClearImportFilter,
  initialView,
}: {
  summary: CatalogTaskSummary | null;
  onSummaryChange: () => void;
  importId: string | null;
  onClearImportFilter: () => void;
  initialView?: ViewId;
}) {
  const { permissionKeys } = usePermissions();
  const canWrite = permissionKeys.includes("products.manage");
  const { categories } = useProductMeta();

  const [view, setView] = useState<ViewId>(initialView ?? "all");
  const [statusView, setStatusView] = useState<StatusViewId>("open");
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [page, setPage] = useState(1);

  const [items, setItems] = useState<CatalogTask[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [applyingSafe, setApplyingSafe] = useState(false);
  const [chosenCategory, setChosenCategory] = useState<Record<string, string>>({});
  const [reviewProductId, setReviewProductId] = useState<string | null>(null);
  /** Set once the first refresh has run, so opening the page doesn't show a stale queue. */
  const [refreshed, setRefreshed] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 350);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [view, statusView, debounced, importId]);

  const query = useMemo(
    () => toQuery(view, statusView, debounced, importId, page),
    [view, statusView, debounced, importId, page],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchCatalogTasks(query);
      setItems(result.items);
      setTotal(result.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load the work queue");
    } finally {
      setLoading(false);
    }
  }, [query]);

  /*
   * Recompute once when the page opens, then load. Without this the queue would show whatever
   * the last import left behind, which is exactly the staleness the durable table was meant to
   * fix in the other direction — persistence is only an improvement if it is also current.
   */
  useEffect(() => {
    if (refreshed || !canWrite) {
      void load();
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        await refreshCatalogTasks();
      } catch {
        // A refresh failure is not a reason to show nothing — fall through to whatever is stored.
      }
      if (cancelled) return;
      setRefreshed(true);
      onSummaryChange();
      void load();
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshed, canWrite, load, onSummaryChange]);

  const categoryOptions = useMemo<SelectFieldOption[]>(() => {
    const departments = categories.filter((c) => !c.parentCategoryId);
    const options: SelectFieldOption[] = [{ value: "", label: "Choose a category…" }];
    for (const dept of departments) {
      options.push({ value: dept.id, label: `${dept.name} (department)`, shortLabel: dept.name });
      for (const child of categories.filter((c) => c.parentCategoryId === dept.id)) {
        options.push({
          value: child.id,
          label: `${dept.name} › ${child.name}`,
          shortLabel: child.name,
        });
      }
    }
    return options;
  }, [categories]);

  async function act(
    task: CatalogTask,
    action: "apply" | "dismiss" | "not-applicable" | "reopen",
  ) {
    setBusyId(task.id);
    setError(null);
    setNotice(null);
    try {
      if (action === "apply") {
        const chosen = chosenCategory[task.id];
        await applyCatalogTask(task.id, chosen ? { categoryId: chosen } : undefined);
        setNotice(`"${task.product.name}" updated.`);
      } else {
        await closeCatalogTask(task.id, action);
        setNotice(
          action === "reopen"
            ? `"${task.product.name}" is back in the queue.`
            : `"${task.product.name}" closed.`,
        );
      }
      await load();
      onSummaryChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't update that task");
    } finally {
      setBusyId(null);
    }
  }

  const safeCount = summary?.safeToApply ?? 0;

  async function applySafe() {
    setApplyingSafe(true);
    setError(null);
    setNotice(null);
    try {
      const result = await applySafeCatalogTasks(query, safeCount);
      const parts = [`${result.applied.toLocaleString()} change${result.applied === 1 ? "" : "s"} applied`];
      if (result.failed.length > 0) {
        parts.push(`${result.failed.length.toLocaleString()} couldn't be applied — ${result.failed[0].reason}`);
      }
      setNotice(parts.join(". "));
      await load();
      onSummaryChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't apply those changes");
    } finally {
      setApplyingSafe(false);
    }
  }

  const columns: Column<CatalogTask>[] = useMemo(
    () => [
      {
        key: "product",
        header: "Product",
        render: (task) => (
          <div className={css.taskProduct}>
            <Link href={`/products/${task.product.id}`} className={css.taskProductName}>
              {task.product.name}
              {task.product.brandName ? ` — ${task.product.brandName}` : ""}
            </Link>
            <span className={css.taskProductMeta}>
              {[
                task.product.sku,
                task.product.genericName,
                [task.product.dosageForm, task.product.strength].filter(Boolean).join(" · "),
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
            {/* Provenance: which import this product came from, and which row of it. Without
                it a task raised by a 2,000-row upload is untraceable back to the upload. */}
            {task.importFilename && (
              <span className={css.taskProvenance}>
                From {task.importFilename}
                {task.sourceRow ? ` · row ${task.sourceRow}` : ""}
              </span>
            )}
          </div>
        ),
      },
      {
        key: "type",
        header: "Task",
        width: "150px",
        render: (task) => {
          const map = {
            MISSING_CATEGORY: { label: "Needs category", cls: css.typeChipCategory },
            NMRA_MATCH: { label: "Register match", cls: css.typeChipMatch },
            NMRA_AMBIGUOUS: { label: "Ambiguous", cls: css.typeChipAmbiguous },
            IMPORT_DUPLICATE: { label: "Import duplicate", cls: css.typeChipAmbiguous },
          } as const;
          const meta = map[task.type];
          return <span className={`${css.typeChip} ${meta.cls}`}>{meta.label}</span>;
        },
      },
      {
        key: "suggestion",
        header: "Suggested change",
        render: (task) => {
          if (task.type === "MISSING_CATEGORY") {
            // A category task without a suggestion still needs an answer, so the picker is
            // offered inline rather than sending the user off to the product page.
            if (!isCategorySuggestion(task.suggestion) && canWrite && task.status !== "RESOLVED") {
              return (
                <SelectField
                  hideLabel
                  label={`Category for ${task.product.name}`}
                  className={css.rowSelect}
                  fullWidth={false}
                  value={chosenCategory[task.id] ?? ""}
                  onChange={(value) =>
                    setChosenCategory((prev) => ({ ...prev, [task.id]: value }))
                  }
                  options={categoryOptions}
                  wideMenu
                />
              );
            }
            if (isCategorySuggestion(task.suggestion)) {
              return (
                <div className={css.suggestion}>
                  <span className={css.suggestionText}>{task.suggestion.categoryPath}</span>
                  {canWrite && task.status !== "RESOLVED" && (
                    <SelectField
                      hideLabel
                      label={`Choose a different category for ${task.product.name}`}
                      className={css.rowSelect}
                      fullWidth={false}
                      value={chosenCategory[task.id] ?? task.suggestion.categoryId}
                      onChange={(value) =>
                        setChosenCategory((prev) => ({ ...prev, [task.id]: value }))
                      }
                      options={categoryOptions}
                      wideMenu
                    />
                  )}
                </div>
              );
            }
            return <span className={css.suggestionNone}>No suggestion</span>;
          }

          if (isReferenceSuggestion(task.suggestion)) {
            return (
              <div className={css.suggestion}>
                <span className={css.suggestionText}>
                  {task.suggestion.name}
                  {task.suggestion.brandName ? ` — ${task.suggestion.brandName}` : ""}
                </span>
                {task.suggestion.registrationNo && (
                  <span className={css.suggestionSub}>Reg. {task.suggestion.registrationNo}</span>
                )}
              </div>
            );
          }

          if (task.candidates.length > 1) {
            return (
              <div className={css.suggestion}>
                <span className={css.suggestionNone}>
                  {task.candidates.length} register entries share this identifier
                </span>
                <span className={css.suggestionSub}>
                  {task.candidates.slice(0, 2).map((c) => c.name).join(", ")}
                  {task.candidates.length > 2 ? "…" : ""}
                </span>
              </div>
            );
          }

          return <span className={css.suggestionNone}>{task.detail ?? "No suggestion"}</span>;
        },
      },
      {
        key: "evidence",
        header: "Evidence",
        width: "180px",
        render: (task) => (
          <div className={css.evidence}>
            {task.evidenceLabel ? (
              <span
                className={`${css.evidenceChip}${
                  (task.confidence ?? 0) < 0.9 ? ` ${css.evidenceChipWeak}` : ""
                }`}
              >
                {task.evidenceLabel}
              </span>
            ) : (
              <span className={`${css.evidenceChip} ${css.evidenceChipWeak}`}>No evidence</span>
            )}
            {task.confidence != null && (
              <span className={css.confidence}>{Math.round(task.confidence * 100)}%</span>
            )}
            {/* Spelled out, not a colour: this is the difference between a product being
                dispensable and not. */}
            {task.complianceImpact && (
              <span className={`${css.evidenceChip} ${css.evidenceChipCompliance}`}>
                <IconAlertTriangle size={10} aria-hidden />
                Changes compliance
              </span>
            )}
          </div>
        ),
      },
      {
        key: "actions",
        header: "Action",
        width: "170px",
        align: "right",
        /*
         * One primary action, and everything else behind the overflow menu.
         *
         * The first version put "Review" and "N/A" side by side on every row, which meant a
         * queue of fifty unmatched products offered "N/A" fifty times as its most prominent
         * control — the least useful thing a person could do, given top billing. The primary
         * action is now whatever this particular task is actually asking for: file it, link
         * it, or go and find the register entry it couldn't.
         */
        render: (task) => {
          if (!canWrite) return null;
          const busy = busyId === task.id;

          if (statusView !== "open") {
            return (
              <div className={css.rowActions}>
                <span className={css.statusChip}>{STATUS_LABELS[task.status]}</span>
                <button
                  type="button"
                  className={css.rowBtn}
                  disabled={busy}
                  onClick={() => void act(task, "reopen")}
                >
                  Reopen
                </button>
              </div>
            );
          }

          const isCategory = task.type === "MISSING_CATEGORY";
          const chosen = chosenCategory[task.id];
          const suggestedCategoryId = isCategorySuggestion(task.suggestion)
            ? task.suggestion.categoryId
            : undefined;
          const canFile = Boolean(chosen ?? suggestedCategoryId);
          const canLink = isReferenceSuggestion(task.suggestion) && !task.complianceImpact;

          const secondary = [
            ...(!isCategory
              ? [
                  {
                    label: task.complianceImpact
                      ? "Review the compliance change…"
                      : "Compare with the register…",
                    onClick: () => setReviewProductId(task.product.id),
                  },
                ]
              : []),
            {
              label: "Not a medicine",
              hint: "Stops this product appearing in the register queue",
              onClick: () => void act(task, "not-applicable"),
            },
            {
              label: "Dismiss",
              hint: "I've looked — there's nothing to do here",
              separated: true,
              onClick: () => void act(task, "dismiss"),
            },
          ];

          return (
            <div className={css.rowActions}>
              {isCategory ? (
                <button
                  type="button"
                  className={`${css.rowBtn} ${css.rowBtnPrimary}`}
                  disabled={busy || !canFile}
                  data-tooltip={canFile ? undefined : "Choose a category first"}
                  onClick={() => void act(task, "apply")}
                >
                  {busy ? "Filing…" : "File"}
                </button>
              ) : canLink ? (
                <button
                  type="button"
                  className={`${css.rowBtn} ${css.rowBtnPrimary}`}
                  disabled={busy}
                  onClick={() => void act(task, "apply")}
                >
                  {busy ? "Linking…" : "Link"}
                </button>
              ) : (
                /* No match, or one that changes a compliance flag — either way the honest
                   next step is to open the register and look, not to offer a one-click apply. */
                <button
                  type="button"
                  className={css.rowBtn}
                  disabled={busy}
                  onClick={() => setReviewProductId(task.product.id)}
                >
                  {task.complianceImpact ? "Review" : "Find match"}
                </button>
              )}
              <RowMenu label={task.product.name} actions={secondary} />
            </div>
          );
        },
      },
    ],
    // `act` is recreated each render but only reads state it already closes over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busyId, canWrite, categoryOptions, chosenCategory, statusView],
  );

  return (
    <div className={css.page}>
      {/* A sentence and a thin bar, not a wall of tiles. Each count is also the filter for it,
          so reading the summary and acting on it are one gesture. */}
      {summary && (
        <div className={css.summary}>
          <span className={css.summaryTotal}>
            {summary.open.toLocaleString()}
            <span className={css.summaryTotalLabel}>open task{summary.open === 1 ? "" : "s"}</span>
          </span>
          <div className={css.summaryChips}>
            <SummaryChip
              label="need a category"
              count={summary.needsCategory}
              active={view === "needs_category"}
              onClick={() => setView(view === "needs_category" ? "all" : "needs_category")}
            />
            <SummaryChip
              label="register matches"
              count={summary.nmraMatch}
              active={view === "nmra_match"}
              onClick={() => setView(view === "nmra_match" ? "all" : "nmra_match")}
            />
            <SummaryChip
              label="need compliance review"
              count={summary.complianceReview}
              attention
              active={view === "compliance"}
              onClick={() => setView(view === "compliance" ? "all" : "compliance")}
            />
            <SummaryChip
              label="from recent imports"
              count={summary.fromRecentImports}
              active={false}
              onClick={() => setView("all")}
            />
          </div>
          <div className={css.coverage}>
            <div className={css.coverageBar}>
              <div
                className={css.coverageFill}
                style={{ width: `${summary.categoryCoveragePercent}%` }}
                role="progressbar"
                aria-valuenow={summary.categoryCoveragePercent}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Products filed under a category"
              />
            </div>
            <span className={css.coverageText}>{summary.categoryCoveragePercent}% filed</span>
          </div>
        </div>
      )}

      <div className={css.toolbar}>
        <div className={css.toolbarGroup}>
          <div className={css.searchWrap}>
            <IconSearch size={15} className={css.searchIcon} />
            <input
              className={css.searchInput}
              type="search"
              placeholder="Search tasks…"
              aria-label="Search tasks"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className={css.filterChips} role="group" aria-label="Filter by task type">
            {VIEWS.map((v) => (
              <button
                key={v.id}
                type="button"
                aria-pressed={view === v.id}
                className={`${css.filterChip}${view === v.id ? ` ${css.filterChipActive}` : ""}`}
                onClick={() => setView(v.id)}
              >
                {v.label}
              </button>
            ))}
          </div>
          <div className={css.filterChips} role="group" aria-label="Filter by status">
            {STATUS_VIEWS.map((v) => (
              <button
                key={v.id}
                type="button"
                aria-pressed={statusView === v.id}
                className={`${css.filterChip}${statusView === v.id ? ` ${css.filterChipActive}` : ""}`}
                onClick={() => setStatusView(v.id)}
              >
                {v.label}
              </button>
            ))}
          </div>
          {importId && (
            <span className={css.importScope}>
              Showing one import&apos;s tasks
              <button
                type="button"
                className={css.importScopeClear}
                aria-label="Show tasks from every import"
                onClick={onClearImportFilter}
              >
                <IconX size={12} />
              </button>
            </span>
          )}
        </div>

        {canWrite && safeCount > 0 && statusView === "open" && (
          <div className={css.toolbarActions}>
            <ActionButton
              icon={<IconCheck size={15} />}
              disabled={applyingSafe}
              onClick={() => void applySafe()}
              tooltip="High-confidence, unique matches that change no compliance flag. Anything ambiguous or compliance-sensitive is left for you."
            >
              {applyingSafe
                ? "Applying…"
                : `Apply ${safeCount.toLocaleString()} safe change${safeCount === 1 ? "" : "s"}`}
            </ActionButton>
          </div>
        )}
      </div>

      {error && (
        <Alert variant="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {notice && (
        <Alert variant="success" onClose={() => setNotice(null)}>
          {notice}
        </Alert>
      )}

      {!loading && items.length === 0 ? (
        <div className={css.card}>
          <p className={css.done}>
            <IconCheckCircle size={18} aria-hidden />
            {statusView === "open" ? "Nothing left to review." : "Nothing here."}
          </p>
          <p className={css.empty}>
            {statusView === "open" ? (
              <>
                Every product you sell is filed and matched.{" "}
                <Link href="/products" className={css.link}>
                  Back to Products
                </Link>
                .
              </>
            ) : (
              "No tasks in this state."
            )}
          </p>
        </div>
      ) : (
        <DataTable<CatalogTask>
          columns={columns}
          data={items}
          rowKey={(t) => t.id}
          loading={loading}
          page={page}
          pageSize={PAGE_SIZE}
          total={total}
          onPageChange={setPage}
          compact
          emptyTitle="No tasks match"
          emptyDescription="Try a different filter."
          emptyIcon={<IconGrid size={42} />}
        />
      )}

      <ProductNmraLinkModal
        open={reviewProductId !== null}
        productId={reviewProductId ?? ""}
        onClose={() => setReviewProductId(null)}
        onLinked={() => {
          setReviewProductId(null);
          void load();
          onSummaryChange();
        }}
      />
    </div>
  );
}

function SummaryChip({
  label,
  count,
  active,
  attention,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  attention?: boolean;
  onClick: () => void;
}) {
  if (count === 0) return null;
  return (
    <button
      type="button"
      aria-pressed={active}
      className={`${css.summaryChip}${active ? ` ${css.summaryChipActive}` : ""}${
        attention && !active ? ` ${css.summaryChipAttention}` : ""
      }`}
      onClick={onClick}
    >
      <span className={css.summaryChipCount}>{count.toLocaleString()}</span>
      {label}
    </button>
  );
}

export type { ViewId as WorkQueueViewId };
