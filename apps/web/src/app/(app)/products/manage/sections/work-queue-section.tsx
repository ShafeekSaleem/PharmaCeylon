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
} from "@/components/icons";
import {
  ActionButton,
  ActiveFilterBanner,
  CategoryPicker,
  DataTable,
  RowMenu,
  type Column,
  type FilterPill,
} from "@/components/ui";
import { usePermissions } from "@/lib/permissions";
import {
  applyCatalogTask,
  applySafeCatalogTasks,
  closeCatalogTask,
  fetchCatalogTasks,
  refreshCatalogTasks,
  type CatalogTask,
  type CatalogTaskCounts,
  type CatalogTaskQuery,
  type CatalogTaskSummary,
  type CategorySuggestion,
  type ReferenceSuggestion,
} from "../../api/catalog-tasks";
import { useProductMeta } from "../../hooks/use-product-meta";
import { ProductNmraLinkModal } from "../../components/product-nmra-link-modal";
import css from "../manage.module.css";

const PAGE_SIZE = 50;

/**
 * The cross-cutting views the filter chips offer, in the order they are shown. `tone` is the
 * colour the same thing already wears in the table — a category task's chip is info-blue in
 * both places — so the filter row and its results read as one thing.
 */
const VIEWS = [
  { id: "all", label: "All tasks", tone: null },
  { id: "needs_category", label: "Needs category", tone: "info" },
  { id: "nmra_match", label: "NMRA match", tone: "primary" },
  { id: "compliance", label: "Compliance", tone: "warning" },
  { id: "ambiguous", label: "Ambiguous", tone: "warning" },
  { id: "no_suggestion", label: "No suggestion", tone: null },
] as const;

type ViewId = (typeof VIEWS)[number]["id"];

/**
 * How a task was closed. Open is the queue's resting state, not one of these — the same way
 * "All tasks" is the resting state of the type row rather than a chip you press to get back
 * to. It had a chip of its own, which on arrival read "All tasks 211 … Open 211": two
 * highlighted chips carrying one number, neither of which did anything when clicked.
 *
 * So these three are toggles over that default. Pressing one shows closed work of that kind;
 * pressing it again — or Clear filter — returns to the open queue.
 */
const STATUS_VIEWS = [
  { id: "resolved", label: "Resolved", tone: "success" },
  { id: "dismissed", label: "Dismissed", tone: null },
  { id: "not_applicable", label: "Not applicable", tone: null },
] as const;

/** The resting state, plus the three closed states the chips select. */
type StatusViewId = "open" | (typeof STATUS_VIEWS)[number]["id"];

type ChipTone = "info" | "primary" | "warning" | "success" | null;

const TONE_CLASS: Record<Exclude<ChipTone, null>, string> = {
  info: css.chipInfo,
  primary: css.chipPrimary,
  warning: css.chipWarning,
  success: css.chipSuccess,
};

/**
 * One definition of what each kind of task is called and what colour it wears, so the chip in
 * the Task column, the evidence beside it and the filter that selects it can't drift apart.
 */
const TASK_META: Record<
  CatalogTask["type"],
  { label: string; tone: Exclude<ChipTone, null> }
> = {
  MISSING_CATEGORY: { label: "Needs category", tone: "info" },
  NMRA_MATCH: { label: "Register match", tone: "primary" },
  NMRA_AMBIGUOUS: { label: "Ambiguous", tone: "warning" },
  IMPORT_DUPLICATE: { label: "Import duplicate", tone: "warning" },
};

function chipClass(tone: ChipTone, active: boolean): string {
  return [
    css.filterChip,
    tone ? TONE_CLASS[tone] : "",
    active ? css.filterChipActive : "",
  ]
    .filter(Boolean)
    .join(" ");
}

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

/**
 * The brand, only when it says something the name doesn't. Register rows routinely carry the
 * brand as their name too, and "HUMAINE 50 — HUMAINE" is noise on every row of the queue.
 */
function distinctBrand(product: CatalogTask["product"]): string | null {
  const brand = product.brandName?.trim();
  if (!brand) return null;
  const name = product.name.trim().toUpperCase();
  return name.includes(brand.toUpperCase()) ? null : brand;
}

/**
 * Generic name, then form and strength — but only the parts the generic name hasn't already
 * said. NMRA generic names often read "CYCLOSPORINE CAPSULES USP 50MG", which made the meta
 * line repeat its own dosage form and strength back to itself.
 */
function productMeta(product: CatalogTask["product"]): string {
  const generic = product.genericName?.trim() ?? "";
  const said = generic.toUpperCase();
  const extras = [product.dosageForm, product.strength]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .filter((part) => !said.includes(part.toUpperCase()));
  return [generic, extras.join(" ")].filter(Boolean).join(" · ");
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
  /*
   * Chip counts for the filter the queue is currently showing. They used to come from the
   * tenant-wide summary, which knows nothing about the filter: selecting "Resolved" left
   * "Needs category 213" on a row of thirty resolved tasks, and "Apply 18 safe changes"
   * offered a number counted across the whole tenant while the endpoint behind it only ever
   * applies within the filter.
   */
  const [counts, setCounts] = useState<CatalogTaskCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [applyingSafe, setApplyingSafe] = useState(false);
  const [chosenCategory, setChosenCategory] = useState<Record<string, string>>(
    {},
  );
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

  /*
   * What is currently narrowing the queue, said in words. Two rows of chips make it easy to
   * leave one selected, scroll, and then read an empty table as "nothing to do" — which on a
   * queue is the one wrong conclusion to draw. Same banner, same wording and the same single
   * "Clear filter" as Products, Inventory and Reports.
   */
  const filtersActive =
    view !== "all" ||
    statusView !== "open" ||
    debounced.trim().length > 0 ||
    Boolean(importId);

  const filterPills = useMemo<FilterPill[]>(() => {
    const pills: FilterPill[] = [];
    if (view !== "all") {
      pills.push({
        key: "view",
        label: VIEWS.find((v) => v.id === view)?.label ?? view,
      });
    }
    if (statusView !== "open") {
      pills.push({
        key: "status",
        label: STATUS_VIEWS.find((v) => v.id === statusView)?.label ?? statusView,
      });
    }
    if (debounced.trim()) {
      pills.push({ key: "q", label: `Search "${debounced.trim()}"` });
    }
    if (importId) pills.push({ key: "import", label: "One import" });
    return pills;
  }, [view, statusView, debounced, importId]);

  const clearFilters = useCallback(() => {
    setView("all");
    setStatusView("open");
    setSearch("");
    if (importId) onClearImportFilter();
  }, [importId, onClearImportFilter]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchCatalogTasks(query);
      setItems(result.items);
      setTotal(result.total);
      setCounts(result.counts);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Couldn't load the work queue",
      );
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
        await applyCatalogTask(
          task.id,
          chosen ? { categoryId: chosen } : undefined,
        );
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
      setError(
        err instanceof Error ? err.message : "Couldn't update that task",
      );
    } finally {
      setBusyId(null);
    }
  }

  /* Scoped to the filter, because that is what the endpoint behind the button acts on. */
  const safeCount = counts?.safeToApply ?? 0;

  async function applySafe() {
    setApplyingSafe(true);
    setError(null);
    setNotice(null);
    try {
      const result = await applySafeCatalogTasks(query, safeCount);
      const parts = [
        `${result.applied.toLocaleString()} change${result.applied === 1 ? "" : "s"} applied`,
      ];
      if (result.failed.length > 0) {
        parts.push(
          `${result.failed.length.toLocaleString()} couldn't be applied — ${result.failed[0].reason}`,
        );
      }
      setNotice(parts.join(". "));
      await load();
      onSummaryChange();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Couldn't apply those changes",
      );
    } finally {
      setApplyingSafe(false);
    }
  }

  const columns: Column<CatalogTask>[] = useMemo(
    () => [
      {
        key: "product",
        header: "Product",
        /*
         * Two lines, not four. This column had the name, then SKU + generic + form + strength,
         * then the import filename and row — on fifty rows at once, which buried the name it
         * exists to show. What identifies a medicine to a pharmacist is its generic and its
         * strength; the SKU is a number nobody reads across, and the provenance is a fact you
         * want once, when a task looks wrong, so it is a chip with the filename in its tooltip
         * rather than a third line on every row.
         */
        render: (task) => {
          const meta = productMeta(task.product);
          const brand = distinctBrand(task.product);
          return (
            <div className={css.taskProduct}>
              <Link
                href={`/products/${task.product.id}`}
                className={css.taskProductName}
              >
                {task.product.name}
                {brand ? ` — ${brand}` : ""}
              </Link>
              {(meta || task.importFilename) && (
                <span className={css.taskProductMeta}>
                  {meta}
                  {task.importFilename && (
                    <span
                      className={css.importChip}
                      data-tooltip={`From ${task.importFilename}${
                        task.sourceRow ? ` · row ${task.sourceRow}` : ""
                      }`}
                    >
                      imported
                    </span>
                  )}
                </span>
              )}
            </div>
          );
        },
      },
      {
        key: "type",
        header: "Task",
        width: "150px",
        render: (task) => {
          const meta = TASK_META[task.type];
          return (
            <span className={`${css.toneChip} ${TONE_CLASS[meta.tone]}`}>
              {meta.label}
            </span>
          );
        },
      },
      {
        key: "suggestion",
        header: "Suggested change",
        width: "250px",
        render: (task) => {
          if (task.type === "MISSING_CATEGORY") {
            // A category task without a suggestion still needs an answer, so the picker is
            // offered inline rather than sending the user off to the product page.
            const suggested = isCategorySuggestion(task.suggestion)
              ? task.suggestion
              : null;

            // The picker shows the suggestion as its selected value, so printing the path
            // beside it would say the same thing twice on every suggested row.
            if (canWrite && task.status !== "RESOLVED") {
              return (
                <CategoryPicker
                  compact
                  className={css.rowSelect}
                  label={`Category for ${task.product.name}`}
                  categories={categories}
                  value={chosenCategory[task.id] ?? suggested?.categoryId ?? ""}
                  onChange={(value) =>
                    setChosenCategory((prev) => ({ ...prev, [task.id]: value }))
                  }
                />
              );
            }
            if (suggested) {
              return (
                <span className={css.suggestionText}>
                  {suggested.categoryPath}
                </span>
              );
            }
            return <span className={css.suggestionNone}>No suggestion</span>;
          }

          if (isReferenceSuggestion(task.suggestion)) {
            return (
              <div className={css.suggestion}>
                <span className={css.suggestionText}>
                  {task.suggestion.name}
                  {task.suggestion.brandName
                    ? ` — ${task.suggestion.brandName}`
                    : ""}
                </span>
                {task.suggestion.registrationNo && (
                  <span className={css.suggestionSub}>
                    Reg. {task.suggestion.registrationNo}
                  </span>
                )}
              </div>
            );
          }

          if (task.candidates.length > 1) {
            return (
              <div className={css.suggestion}>
                <span className={css.suggestionNone}>
                  {task.candidates.length} register entries share this
                  identifier
                </span>
                <span className={css.suggestionSub}>
                  {task.candidates
                    .slice(0, 2)
                    .map((c) => c.name)
                    .join(", ")}
                  {task.candidates.length > 2 ? "…" : ""}
                </span>
              </div>
            );
          }

          return (
            <span className={css.suggestionNone}>
              {task.detail ?? "No suggestion"}
            </span>
          );
        },
      },
      {
        key: "evidence",
        header: "Evidence",
        width: "180px",
        /*
         * What matched, and how strongly, in one capsule.
         *
         * These were two things side by side — a tinted chip and a little progress bar with a
         * percentage next to it — which read as two separate findings about the row when they
         * are one: "matched on the barcode, 96% sure". The strength is now the second half of
         * the same capsule, and the capsule wears its row's task colour so the Task column and
         * the Evidence column are visibly about the same thing.
         */
        render: (task) => (
          <div className={css.evidence}>
            <span
              className={`${css.toneChip}${
                task.evidenceLabel
                  ? ` ${TONE_CLASS[TASK_META[task.type].tone]}`
                  : ""
              }`}
              aria-label={confidenceLabel(task)}
            >
              <span>{task.evidenceLabel ?? "No evidence"}</span>
              {task.confidence != null && (
                <span className={css.chipStrength} aria-hidden>
                  {Math.round(task.confidence * 100)}%
                </span>
              )}
            </span>
            {/* Spelled out, not a colour: this is the difference between a product being
                dispensable and not. */}
            {task.complianceImpact && (
              <span className={`${css.toneChip} ${css.chipWarning}`}>
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
                <span className={css.statusChip}>
                  {STATUS_LABELS[task.status]}
                </span>
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
          const canLink =
            isReferenceSuggestion(task.suggestion) && !task.complianceImpact;

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
    [busyId, canWrite, categories, chosenCategory, statusView],
  );

  return (
    <div className={css.page}>
      {/*
       * One filter row, not two. The summary bar above this used to carry "213 need a category"
       * as a clickable chip and the row below it carried "Needs category" as another — the same
       * filter, twice, in two different shapes. The counts now live on the filters themselves,
       * which is the only place they were ever acted on.
       */}
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
        </div>

        {summary && (
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
            <span className={css.coverageText}>
              {summary.categoryCoveragePercent}% filed
            </span>
          </div>
        )}

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

        <div className={css.toolbarFilters}>
          <div
            className={css.filterChips}
            role="group"
            aria-label="Filter by task type"
          >
            {VIEWS.map((v) => (
              <FilterChip
                key={v.id}
                label={v.label}
                tone={v.tone}
                /* Counted under the status filter that is actually applied, so the number
                   on the chip is the number of rows clicking it produces. */
                count={counts ? viewCount(v.id, counts) : null}
                active={view === v.id}
                onClick={() => setView(v.id)}
              />
            ))}
          </div>
          <div
            className={css.filterChips}
            role="group"
            aria-label="Filter by status"
          >
            {/* Divider rather than a "Status" heading: the labels are self-evidently statuses,
                and the heading was the last thing keeping this off one line. */}
            <span className={css.filterDivider} aria-hidden />
            {STATUS_VIEWS.map((v) => (
              <FilterChip
                key={v.id}
                label={v.label}
                tone={v.tone}
                count={counts ? statusCount(v.id, counts) : null}
                active={statusView === v.id}
                /* Pressing the selected one again drops back to the open queue, since
                   there is no longer an "Open" chip to press instead. */
                onClick={() =>
                  setStatusView((prev) => (prev === v.id ? "open" : v.id))
                }
              />
            ))}
          </div>
        </div>
      </div>

      <ActiveFilterBanner
        active={filtersActive}
        summary={`Filtered tasks · ${total.toLocaleString()} task${
          total === 1 ? "" : "s"
        }`}
        pills={filterPills}
        onClear={clearFilters}
        clearTooltip="Back to every open task"
      />

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
            {statusView === "open"
              ? "Nothing left to review."
              : "Nothing here."}
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
          fixedLayout
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

/**
 * A filter that states its own size. Tinted with the tone the same kind of task wears in the
 * table, so following "Compliance review 25" through to the rows it returns never changes
 * colour on the way.
 */
function FilterChip({
  label,
  tone,
  count,
  active,
  onClick,
}: {
  label: string;
  tone: ChipTone;
  count: number | null;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={chipClass(tone, active)}
      onClick={onClick}
    >
      {tone && <span className={css.chipDot} aria-hidden />}
      {label}
      {count !== null && (
        <span className={css.chipCount}>{count.toLocaleString()}</span>
      )}
    </button>
  );
}

/**
 * The evidence capsule's accessible name. On screen the capsule reads "Exact barcode 96%",
 * which is enough next to the rest of the row; read aloud it needs to say what the number is
 * and how strong that is, since the shading that carries the band visually is not available.
 */
function confidenceLabel(task: CatalogTask): string {
  const what = task.evidenceLabel ?? "No evidence";
  if (task.confidence == null) return what;
  const pct = Math.round(task.confidence * 100);
  const band = pct >= 90 ? "strong" : pct >= 70 ? "fair" : "weak";
  return `${what}, ${pct}% confidence, ${band}`;
}

function viewCount(id: ViewId, counts: CatalogTaskCounts): number {
  switch (id) {
    case "needs_category":
      return counts.needsCategory;
    case "nmra_match":
      return counts.nmraMatch;
    case "compliance":
      return counts.compliance;
    case "ambiguous":
      return counts.ambiguous;
    case "no_suggestion":
      return counts.noSuggestion;
    default:
      return counts.all;
  }
}

function statusCount(id: StatusViewId, counts: CatalogTaskCounts): number {
  switch (id) {
    case "resolved":
      return counts.resolved;
    case "dismissed":
      return counts.dismissed;
    case "not_applicable":
      return counts.notApplicable;
    default:
      return counts.open;
  }
}

export type { ViewId as WorkQueueViewId };
