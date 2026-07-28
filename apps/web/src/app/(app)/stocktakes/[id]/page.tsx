"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Alert } from "@/components/alert";
import { IconCheck, IconClipboard, IconLock } from "@/components/icons";
import { ActionButton } from "@/components/ui";
import { apiJson } from "@/lib/auth-client";
import { usePageChrome } from "@/lib/page-chrome-context";
import { LINE_FILTER_OPTIONS } from "../constants";
import { EditStocktakeModal } from "../components/edit-stocktake-modal";
import { ManageStocktakeLinesModal } from "../components/manage-stocktake-lines-modal";
import { StocktakeActionsMenu } from "../components/stocktake-actions-menu";
import { StocktakeActivityTab } from "../components/stocktake-activity-tab";
import { StocktakeCountTab } from "../components/stocktake-count-tab";
import { StocktakeDetailsTab } from "../components/stocktake-details-tab";
import { StocktakeHeader } from "../components/stocktake-header";
import {
  StocktakeReviewTab,
  type ReviewDraft,
} from "../components/stocktake-review-tab";
import { StocktakeReviewSidebar } from "../components/stocktake-review-sidebar";
import { StocktakeSummarySidebar } from "../components/stocktake-summary-sidebar";
import { StocktakeTablePager } from "../components/stocktake-table-pager";
import { useStocktakeDetail } from "../hooks/use-stocktake-detail";
import type {
  StocktakeCondition,
  StocktakeLineFilter,
  StocktakeListItem,
  StocktakeVarianceReason,
} from "../types";
import { PAGE_SIZE } from "../types";
import {
  canApprove,
  canEditHeader,
  canManageLines,
  canCancel,
  canComplete,
  canPost,
  canStart,
  canStartReview,
  canSubmit,
  completeBlockers,
  exportStocktakeCsv,
  filterStocktakeLines,
  formatMoney,
  formatSigned,
  lineHasCompleteReview,
  reviewApprovalBlockers,
  showSystemQty,
} from "../utils";
import scss from "../stocktakes.module.css";

type TabKey = "count" | "review" | "activity" | "details";

type DirtyLine = {
  batchId: string;
  countedQty: number;
  note: string | null;
  condition: StocktakeCondition;
};

function syncCountState(detail: StocktakeListItem) {
  const counts: Record<string, string> = {};
  const notes: Record<string, string> = {};
  const conditions: Record<string, StocktakeCondition> = {};
  const reviews: Record<string, ReviewDraft> = {};
  for (const line of detail.lines) {
    counts[line.batchId] = line.countedQty == null ? "" : String(line.countedQty);
    notes[line.batchId] = line.note ?? "";
    conditions[line.batchId] = line.condition;
    reviews[line.id] = {
      reviewReason: (line.reviewReason ?? "") as StocktakeVarianceReason | "",
      reviewResolution: line.reviewResolution ?? "",
      reviewNote: line.reviewNote ?? "",
      selectedForRecount: false,
    };
  }
  return { counts, notes, conditions, reviews };
}

function mergeLocalAfterSave<T extends Record<string, string | StocktakeCondition>>(
  prev: T,
  server: T,
  keptBatchIds: Set<string>,
): T {
  const next = { ...server } as T;
  for (const batchId of keptBatchIds) {
    if (batchId in prev) {
      (next as Record<string, string | StocktakeCondition>)[batchId] = prev[batchId];
    }
  }
  return next;
}

function lineMatchesSearch(line: StocktakeListItem["lines"][number], query: string): boolean {
  if (!query) return true;
  const haystack = [
    line.product.name,
    line.product.sku,
    line.batch.batchNo,
    line.note ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

export default function StocktakeDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const stocktakeId = params?.id;
  const detail = useStocktakeDetail(stocktakeId);
  const { setLastSegmentLabel } = usePageChrome();

  const [activeTab, setActiveTab] = useState<TabKey>("count");
  const [lineFilter, setLineFilter] = useState<StocktakeLineFilter>("all");
  const [reviewFilter, setReviewFilter] = useState<
    "all" | "variances" | "need_approval" | "recount" | "resolved"
  >("variances");
  const [lineSearch, setLineSearch] = useState("");
  const [linePage, setLinePage] = useState(1);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [conditions, setConditions] = useState<Record<string, StocktakeCondition>>({});
  const [reviews, setReviews] = useState<Record<string, ReviewDraft>>({});
  const [saving, setSaving] = useState(false);
  const [lastSavedLabel, setLastSavedLabel] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [linesModal, setLinesModal] = useState<"add" | "remove" | null>(null);

  const dirtyLinesRef = useRef<DirtyLine[]>([]);
  const savingRef = useRef(false);
  const syncedIdRef = useRef<string | null>(null);
  const syncedUpdatedAtRef = useRef<string | null>(null);

  const dirtyLines = useMemo((): DirtyLine[] => {
    if (!detail.data) return [];
    return detail.data.lines
      .map((line) => {
        const raw = (counts[line.batchId] ?? "").trim();
        if (raw === "") return null;
        const qty = Number(raw);
        if (!Number.isInteger(qty) || qty < 0) return null;
        const note = (notes[line.batchId] ?? "").trim();
        const condition = conditions[line.batchId] ?? line.condition;
        if (
          qty === line.countedQty &&
          note === (line.note ?? "") &&
          condition === line.condition
        ) {
          return null;
        }
        return { batchId: line.batchId, countedQty: qty, note: note || null, condition };
      })
      .filter((item): item is DirtyLine => !!item);
  }, [conditions, counts, detail.data, notes]);

  dirtyLinesRef.current = dirtyLines;

  useEffect(() => {
    const label =
      detail.data?.title?.trim() ||
      detail.data?.stocktakeNumber ||
      (stocktakeId ? `${stocktakeId.slice(0, 8)}…` : "Stocktake");
    setLastSegmentLabel(label);
    return () => setLastSegmentLabel(null);
  }, [detail.data?.title, detail.data?.stocktakeNumber, setLastSegmentLabel, stocktakeId]);

  useEffect(() => {
    if (!detail.data) return;
    const idChanged = syncedIdRef.current !== detail.data.id;
    const serverChanged = syncedUpdatedAtRef.current !== detail.data.updatedAt;
    const hasDirty = dirtyLinesRef.current.length > 0;

    // Full replace when switching stocktakes, or when server updated and nothing is dirty.
    if (idChanged || (serverChanged && !hasDirty)) {
      const next = syncCountState(detail.data);
      setCounts(next.counts);
      setNotes(next.notes);
      setConditions(next.conditions);
      setReviews((prev) => {
        const merged: Record<string, ReviewDraft> = {};
        for (const [lineId, draft] of Object.entries(next.reviews)) {
          merged[lineId] = {
            ...draft,
            selectedForRecount: prev[lineId]?.selectedForRecount ?? false,
          };
        }
        return merged;
      });
      syncedIdRef.current = detail.data.id;
      syncedUpdatedAtRef.current = detail.data.updatedAt;
    }
  }, [detail.data]);

  const applyServerDetail = useCallback(
    (next: StocktakeListItem, preserveBatchIds?: Set<string>) => {
      detail.setData(next);
      const synced = syncCountState(next);
      if (preserveBatchIds && preserveBatchIds.size > 0) {
        setCounts((prev) => mergeLocalAfterSave(prev, synced.counts, preserveBatchIds));
        setNotes((prev) => mergeLocalAfterSave(prev, synced.notes, preserveBatchIds));
        setConditions((prev) =>
          mergeLocalAfterSave(prev, synced.conditions, preserveBatchIds),
        );
      } else {
        setCounts(synced.counts);
        setNotes(synced.notes);
        setConditions(synced.conditions);
      }
      setReviews((prev) => {
        const merged: Record<string, ReviewDraft> = {};
        for (const [lineId, draft] of Object.entries(synced.reviews)) {
          merged[lineId] = {
            ...draft,
            selectedForRecount: prev[lineId]?.selectedForRecount ?? false,
          };
        }
        return merged;
      });
      syncedIdRef.current = next.id;
      syncedUpdatedAtRef.current = next.updatedAt;
    },
    [detail],
  );

  const saveCountsNow = useCallback(async () => {
    const row = detail.data;
    const payload = dirtyLinesRef.current;
    if (!row || row.status !== "counting" || payload.length === 0 || savingRef.current) {
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setActionError(null);
    const savedBatchIds = new Set(payload.map((line) => line.batchId));
    try {
      const updated = await apiJson<StocktakeListItem>(`/stocktakes/${row.id}/lines`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lines: payload }),
      });
      setLastSavedLabel(new Date().toLocaleTimeString());
      // Keep any edits typed after this save started.
      const stillDirty = new Set(
        dirtyLinesRef.current
          .filter((line) => {
            const saved = payload.find((p) => p.batchId === line.batchId);
            if (!saved) return true;
            return (
              line.countedQty !== saved.countedQty ||
              line.note !== saved.note ||
              line.condition !== saved.condition
            );
          })
          .map((line) => line.batchId),
      );
      applyServerDetail(updated, stillDirty);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to save counts");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [applyServerDetail, detail.data]);

  useEffect(() => {
    if (!detail.data || detail.data.status !== "counting" || dirtyLines.length === 0) {
      return;
    }
    const timeout = window.setTimeout(() => {
      void saveCountsNow();
    }, 900);
    return () => window.clearTimeout(timeout);
  }, [detail.data, dirtyLines, saveCountsNow]);

  async function reloadSoft() {
    const next = await detail.reload({ soft: true });
    if (next && dirtyLinesRef.current.length === 0) {
      applyServerDetail(next);
    } else if (next) {
      detail.setData(next);
      syncedUpdatedAtRef.current = next.updatedAt;
    }
  }

  async function runAction(path: string, body?: unknown) {
    if (!detail.data) return;
    setSaving(true);
    setActionError(null);
    try {
      await apiJson(`/stocktakes/${detail.data.id}/${path}`, {
        method: "POST",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (path === "complete") {
        router.push("/stocktakes");
        return;
      }
      await reloadSoft();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setSaving(false);
    }
  }

  async function saveReviewNow(opts?: { includeIncomplete?: boolean }) {
    if (!detail.data) return false;
    const lines = detail.data.lines
      .map((line) => {
        const draft = reviews[line.id];
        const reviewReason = draft?.reviewReason || line.reviewReason || null;
        const reviewResolution =
          (draft?.reviewResolution || line.reviewResolution || "").trim() || null;
        const reviewNote = (draft?.reviewNote || line.reviewNote || "").trim() || null;
        const changed =
          reviewReason !== (line.reviewReason ?? null) ||
          reviewResolution !== (line.reviewResolution ?? null) ||
          reviewNote !== (line.reviewNote ?? null);
        if (!changed && !opts?.includeIncomplete) return null;
        if (!reviewReason && !reviewResolution && !reviewNote) return null;
        return {
          lineId: line.id,
          reviewReason,
          reviewResolution,
          reviewNote,
        };
      })
      .filter((line): line is NonNullable<typeof line> => !!line);

    if (lines.length === 0) return true;
    setSaving(true);
    setActionError(null);
    try {
      const updated = await apiJson<StocktakeListItem>(
        `/stocktakes/${detail.data.id}/review-lines`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lines }),
        },
      );
      applyServerDetail(updated);
      setLastSavedLabel(new Date().toLocaleTimeString());
      return true;
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to save review");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function approveStocktake() {
    if (!detail.data) return;
    const blockers = reviewApprovalBlockers(detail.data, reviews);
    if (blockers.length > 0) {
      setActionError(blockers.join("; "));
      setActiveTab("review");
      return;
    }
    const saved = await saveReviewNow({ includeIncomplete: true });
    if (!saved) return;
    await runAction("approve");
  }

  async function requestRecount() {
    if (!detail.data) return;
    const lineIds = Object.entries(reviews)
      .filter(([, draft]) => draft.selectedForRecount)
      .map(([lineId]) => lineId);
    if (lineIds.length === 0) {
      setActionError("Select one or more lines for recount");
      return;
    }
    await runAction("request-recount", { lineIds });
  }

  const showExpected = detail.data ? showSystemQty(detail.data) : false;

  const filterOptions = useMemo(() => {
    if (showExpected) return LINE_FILTER_OPTIONS;
    return LINE_FILTER_OPTIONS.filter((opt) => opt.value !== "variance");
  }, [showExpected]);

  useEffect(() => {
    if (!showExpected && lineFilter === "variance") {
      setLineFilter("all");
    }
  }, [lineFilter, showExpected]);

  const filteredLines = useMemo(() => {
    if (!detail.data) return [];
    const q = lineSearch.trim().toLowerCase();
    const base =
      activeTab === "review"
        ? detail.data.lines
        : filterStocktakeLines(detail.data.lines, lineFilter, {
            counts,
            nearExpiryDays: detail.data.nearExpiryDays ?? 90,
          });

    return base.filter((line) => {
      if (!lineMatchesSearch(line, q)) return false;
      if (activeTab !== "review") return true;
      const draft = reviews[line.id];
      const variance = line.adjustedVariance;
      const hasVariance = variance != null && variance !== 0;
      const isComplete = lineHasCompleteReview(line, draft);
      const isRecount =
        line.countStatus === "recount_requested" || Boolean(draft?.selectedForRecount);

      switch (reviewFilter) {
        case "variances":
          return hasVariance || isRecount;
        case "need_approval":
          return hasVariance && !isComplete && !isRecount;
        case "recount":
          return isRecount;
        case "resolved":
          return isComplete;
        case "all":
        default:
          return true;
      }
    });
  }, [activeTab, counts, detail.data, lineFilter, lineSearch, reviewFilter, reviews]);

  const reviewKpis = useMemo(() => {
    if (!detail.data) {
      return { varianceLines: 0, valueAbs: 0, short: 0, excess: 0, recount: 0, needApproval: 0 };
    }
    const varianceLines = detail.data.lines.filter(
      (line) => line.adjustedVariance != null && line.adjustedVariance !== 0,
    );
    const needApproval = varianceLines.filter((line) => {
      const draft = reviews[line.id];
      return (
        !lineHasCompleteReview(line, draft) &&
        line.countStatus !== "recount_requested" &&
        !draft?.selectedForRecount
      );
    }).length;
    const recount = detail.data.lines.filter(
      (line) =>
        line.countStatus === "recount_requested" || reviews[line.id]?.selectedForRecount,
    ).length;
    return {
      varianceLines: detail.data.varianceLineCount ?? varianceLines.length,
      valueAbs: Math.abs(detail.data.varianceValueApprox ?? 0),
      short: detail.data.varianceUnitsOut ?? 0,
      excess: detail.data.varianceUnitsIn ?? 0,
      recount,
      needApproval,
    };
  }, [detail.data, reviews]);

  const selectedRecountCount = useMemo(
    () => Object.values(reviews).filter((draft) => draft.selectedForRecount).length,
    [reviews],
  );

  useEffect(() => {
    setLinePage(1);
  }, [activeTab, lineFilter, lineSearch, reviewFilter]);

  const pagedLines = useMemo(() => {
    const start = (linePage - 1) * PAGE_SIZE;
    return filteredLines.slice(start, start + PAGE_SIZE);
  }, [filteredLines, linePage]);

  if (detail.loading) {
    return (
      <div className={scss.workspacePage}>
        <Link href="/stocktakes" className={scss.backLink}>
          ← Back to stocktakes
        </Link>
        <div className={scss.loadingCard}>Loading stocktake workspace…</div>
      </div>
    );
  }

  if (detail.error || !detail.data) {
    return (
      <div className={scss.workspacePage}>
        <Link href="/stocktakes" className={scss.backLink}>
          ← Back to stocktakes
        </Link>
        <Alert variant="error">{detail.error ?? "Stocktake not found"}</Alert>
      </div>
    );
  }

  const row = detail.data;
  const blockers = completeBlockers(row, counts, notes);
  const perms = row.permissions;
  const canWrite = perms.canWrite;
  const canReview = perms.canReview;
  const canApprovePerm = perms.canApprove;
  const canPostPerm = perms.canPost;

  const primaryActions: ReactNode[] = [];
  const moreActions: Array<{
    id: string;
    label: string;
    onClick: () => void;
    disabled?: boolean;
    tone?: "danger" | "default";
  }> = [];

  if (canWrite && row.status === "draft" && row.scheduledFor) {
    moreActions.push({
      id: "schedule",
      label: "Schedule",
      onClick: () => void runAction("schedule"),
    });
  }

  if (canWrite && canEditHeader(row.status)) {
    moreActions.push({
      id: "edit-details",
      label: "Edit details",
      onClick: () => setEditOpen(true),
    });
  }

  if (canWrite && canManageLines(row.status)) {
    moreActions.push({
      id: "add-lines",
      label: "Add lines",
      onClick: () => setLinesModal("add"),
    });
    if (row.lines.length > 0) {
      moreActions.push({
        id: "remove-lines",
        label: "Remove lines",
        onClick: () => setLinesModal("remove"),
      });
    }
  }

  if (canWrite && canStart(row.status)) {
    primaryActions.push(
      <ActionButton
        key="start"
        onClick={() => void runAction("start")}
        disabled={saving}
      >
        Start counting
      </ActionButton>,
    );
  }

  if (row.status === "counting" && canWrite) {
    primaryActions.push(
      <ActionButton
        key="submit"
        icon={<IconCheck size={16} />}
        onClick={() => void runAction("submit")}
        disabled={saving || !canSubmit(row.status) || blockers.length > 0}
      >
        Submit count
      </ActionButton>,
    );
  }

  if (canReview && canStartReview(row.status)) {
    primaryActions.push(
      <ActionButton
        key="start-review"
        onClick={() => void runAction("review/start")}
        disabled={saving}
      >
        Start review
      </ActionButton>,
    );
  }

  if (row.status === "under_review" && canReview) {
    moreActions.push({
      id: "save-review",
      label: "Save review notes",
      onClick: () => void saveReviewNow(),
    });
    moreActions.push({
      id: "request-recount",
      label: "Request recount",
      onClick: () => void requestRecount(),
    });
    if (canApprovePerm && canApprove(row.status)) {
      const approveBlocked = reviewApprovalBlockers(row, reviews);
      primaryActions.push(
        <ActionButton
          key="approve"
          onClick={() => void approveStocktake()}
          disabled={saving || approveBlocked.length > 0}
          tooltip={
            approveBlocked.length > 0
              ? approveBlocked.join("; ")
              : "Saves review notes, then approves"
          }
        >
          Approve
        </ActionButton>,
      );
    }
  }

  if (canPostPerm && canPost(row.status)) {
    primaryActions.push(
      <ActionButton
        key="post"
        onClick={() => void runAction("post")}
        disabled={saving}
      >
        Post adjustments
      </ActionButton>,
    );
  }

  if (canApprovePerm && canComplete(row.status)) {
    primaryActions.push(
      <ActionButton
        key="complete"
        onClick={() => void runAction("complete")}
        disabled={saving}
      >
        Complete
      </ActionButton>,
    );
  }

  if (canReview && canCancel(row.status)) {
    moreActions.push({
      id: "cancel",
      label: "Cancel stocktake",
      onClick: () => void runAction("cancel"),
      tone: "danger",
    });
  }

  moreActions.push({
    id: "export",
    label: "Export CSV",
    onClick: () => exportStocktakeCsv(row),
  });

  const reviewLocked = row.blindCount && !showExpected;
  const notesCount = row.lines.filter(
    (line) => (notes[line.batchId] ?? line.note ?? "").trim() !== "",
  ).length;
  const showSidebar = activeTab === "count" || activeTab === "review";

  const saveProgressButton =
    row.status === "counting" && canWrite ? (
      <ActionButton
        variant="secondary"
        icon={<IconClipboard size={14} />}
        onClick={() => void saveCountsNow()}
        disabled={saving || dirtyLines.length === 0}
      >
        {saving ? "Saving…" : "Save progress"}
      </ActionButton>
    ) : null;

  const tabItems: Array<[TabKey, string, number | null, boolean]> = [
    ["count", "Count", row.lineCount, false],
    ["review", "Variance review", showExpected ? row.varianceLineCount : null, reviewLocked],
    ["activity", "Activity", row.activity?.length ?? null, false],
    ["details", "Details", null, false],
  ];

  const linePager =
    filteredLines.length > 0 ? (
      <StocktakeTablePager
        page={linePage}
        pageSize={PAGE_SIZE}
        total={filteredLines.length}
        onPageChange={setLinePage}
      />
    ) : null;

  const tabContent = (
    <>
      {activeTab === "count" ? (
        <StocktakeCountTab
          lines={pagedLines}
          editable={row.status === "counting" && canWrite}
          showExpected={showExpected}
          nearExpiryDays={row.nearExpiryDays ?? 90}
          areaLabel={row.areaLabel}
          counts={counts}
          notes={notes}
          conditions={conditions}
          startIndex={(linePage - 1) * PAGE_SIZE}
          tableFooter={linePager}
          totalLineCount={row.lineCount}
          onAddLines={
            canWrite && canManageLines(row.status) ? () => setLinesModal("add") : undefined
          }
          onCountChange={(batchId, value) =>
            setCounts((current) => ({ ...current, [batchId]: value }))
          }
          onNoteChange={(batchId, value) =>
            setNotes((current) => ({ ...current, [batchId]: value }))
          }
          onConditionChange={(batchId, value) =>
            setConditions((current) => ({ ...current, [batchId]: value }))
          }
        />
      ) : null}

      {activeTab === "review" ? (
        <StocktakeReviewTab
          lines={pagedLines}
          canEdit={canReview && row.status === "under_review"}
          showExpected={showExpected}
          drafts={reviews}
          areaLabel={row.areaLabel}
          nearExpiryDays={row.nearExpiryDays ?? 90}
          tableFooter={linePager}
          onDraftChange={(lineId, draft) =>
            setReviews((current) => ({ ...current, [lineId]: draft }))
          }
        />
      ) : null}
    </>
  );

  return (
    <div className={scss.workspacePage}>
      <div className={scss.workspaceTop}>
        <Link href="/stocktakes" className={scss.backLink}>
          ← Back to stocktakes
        </Link>
      </div>

      {actionError ? <Alert variant="error">{actionError}</Alert> : null}
      {blockers.length > 0 && row.status === "counting" ? (
        <Alert variant="warning">Submit blocked: {blockers.join("; ")}</Alert>
      ) : null}
      {row.status === "under_review" && canApprovePerm ? (
        (() => {
          const approveBlocked = reviewApprovalBlockers(row, reviews);
          return approveBlocked.length > 0 ? (
            <Alert variant="warning">
              Approve blocked: {approveBlocked.join("; ")}. Open Variance review, pick a reason and
              resolution on each non-zero variance line (matched lines with variance 0 can be skipped).
            </Alert>
          ) : null;
        })()
      ) : null}

      <StocktakeHeader
        stocktake={row}
        actions={
          <>
            <StocktakeActionsMenu actions={moreActions} disabled={saving} />
            {primaryActions}
          </>
        }
      />

      <div className={scss.workspaceShell}>
        <div className={scss.tabRow} role="tablist">
          {tabItems.map(([key, label, count, locked]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={activeTab === key}
              className={`${scss.tabBtn}${activeTab === key ? ` ${scss.tabBtnActive}` : ""}`}
              onClick={() => setActiveTab(key)}
            >
              {locked ? (
                <span className={scss.tabLockIcon} title="Locked until review starts">
                  <IconLock size={12} />
                </span>
              ) : null}
              {label}
              {count != null && count > 0 ? (
                <span className={scss.tabCount}>{count}</span>
              ) : null}
            </button>
          ))}
        </div>

        <div className={scss.tabPanel} role="tabpanel">
          {(activeTab === "count" || activeTab === "review") && row.blindCount && !showExpected ? (
            <div className={scss.blindBanner} role="status">
              Blind count is ON — system quantities are hidden until the stocktake is reviewed.
            </div>
          ) : null}

          {activeTab === "review" && showExpected ? (
            <div className={scss.reviewKpiRow}>
              <div className={scss.reviewKpi}>
                <span className={scss.summaryCardLabel}>Total variance lines</span>
                <strong>
                  {reviewKpis.varianceLines}
                  <span className={scss.reviewKpiMeta}>
                    {row.lineCount > 0
                      ? ` (${Math.round((reviewKpis.varianceLines / row.lineCount) * 1000) / 10}%)`
                      : ""}
                  </span>
                </strong>
              </div>
              <div className={scss.reviewKpi}>
                <span className={scss.summaryCardLabel}>Value impact (abs)</span>
                <strong className={scss.varianceNeg}>{formatMoney(reviewKpis.valueAbs)}</strong>
              </div>
              <div className={scss.reviewKpi}>
                <span className={scss.summaryCardLabel}>Units short / excess</span>
                <strong>
                  {formatSigned(-Math.abs(reviewKpis.short))} /{" "}
                  {formatSigned(Math.abs(reviewKpis.excess))}
                </strong>
              </div>
              <div className={scss.reviewKpi}>
                <span className={scss.summaryCardLabel}>Recount requests</span>
                <strong>
                  {reviewKpis.recount}
                  <span className={scss.reviewKpiMeta}>
                    {reviewKpis.needApproval > 0
                      ? ` · ${reviewKpis.needApproval} need approval`
                      : ""}
                  </span>
                </strong>
              </div>
            </div>
          ) : null}

          {activeTab === "count" || activeTab === "review" ? (
            <>
              <div className={scss.lineToolbar}>
                <input
                  className={scss.lineSearch}
                  type="search"
                  value={lineSearch}
                  onChange={(event) => setLineSearch(event.target.value)}
                  placeholder="Scan barcode or search product / batch…"
                  aria-label="Search lines"
                />
                {activeTab === "count" ? (
                  <div className={scss.filterChips} role="group" aria-label="Line filters">
                    {filterOptions.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        className={`${scss.filterChip}${
                          lineFilter === opt.value ? ` ${scss.filterChipActive}` : ""
                        }`}
                        onClick={() => setLineFilter(opt.value)}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className={scss.filterChips} role="group" aria-label="Variance filters">
                    {(
                      [
                        ["variances", "All variances"],
                        ["need_approval", `Need approval ${reviewKpis.needApproval}`],
                        ["recount", `Recount ${reviewKpis.recount}`],
                        ["resolved", "Resolved"],
                        ["all", "All lines"],
                      ] as const
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        className={`${scss.filterChip}${
                          reviewFilter === value ? ` ${scss.filterChipActive}` : ""
                        }`}
                        onClick={() => setReviewFilter(value)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
                <span className={scss.lineCountHint}>
                  Showing {filteredLines.length} of {row.lines.length}
                </span>
              </div>

              {activeTab === "count" ? (
                <div className={scss.countMetaRow}>
                  <span className={scss.uncountedChip}>
                    {row.uncountedLineCount} uncounted
                  </span>
                  <span className={scss.lastSavedHint}>
                    {saving ? (
                      <>
                        <span className={scss.savingDot} aria-hidden />
                        Saving…
                      </>
                    ) : lastSavedLabel ? (
                      `Last saved ${lastSavedLabel} · Auto-saved`
                    ) : (
                      "Not saved yet"
                    )}
                  </span>
                  {saveProgressButton ? (
                    <div className={scss.countMetaActions}>{saveProgressButton}</div>
                  ) : null}
                </div>
              ) : null}

              {activeTab === "review" && canReview && row.status === "under_review" ? (
                <div className={scss.bulkActionRow}>
                  <span className={scss.lastSavedHint}>
                    {selectedRecountCount > 0
                      ? `${selectedRecountCount} selected for recount`
                      : "Select lines to request a recount"}
                  </span>
                  <div className={scss.countMetaActions}>
                    <ActionButton
                      variant="secondary"
                      onClick={() => void requestRecount()}
                      disabled={saving || selectedRecountCount === 0}
                    >
                      Request recount
                    </ActionButton>
                    <ActionButton
                      variant="secondary"
                      onClick={() => void saveReviewNow()}
                      disabled={saving}
                    >
                      Save review notes
                    </ActionButton>
                    <ActionButton
                      variant="secondary"
                      onClick={() => exportStocktakeCsv(row)}
                    >
                      Export CSV
                    </ActionButton>
                  </div>
                </div>
              ) : null}
            </>
          ) : null}

          {showSidebar ? (
            <div className={scss.contentGrid}>
              <div>{tabContent}</div>
              {activeTab === "review" ? (
                <StocktakeReviewSidebar
                  stocktake={row}
                  drafts={reviews}
                  showExpected={showExpected}
                  canEdit={canReview && row.status === "under_review"}
                  onExport={() => exportStocktakeCsv(row)}
                  onRequestRecount={() => void requestRecount()}
                  onSaveReview={() => void saveReviewNow()}
                />
              ) : (
                <StocktakeSummarySidebar
                  stocktake={row}
                  notesCount={notesCount}
                  showExpected={showExpected}
                  onExport={() => exportStocktakeCsv(row)}
                />
              )}
            </div>
          ) : (
            tabContent
          )}

          {activeTab === "activity" ? <StocktakeActivityTab stocktake={row} /> : null}
          {activeTab === "details" ? (
            <StocktakeDetailsTab
              stocktake={row}
              canWrite={canWrite}
              onEditDetails={() => setEditOpen(true)}
              onAddLines={() => setLinesModal("add")}
              onRemoveLines={() => setLinesModal("remove")}
            />
          ) : null}
        </div>
      </div>

      <EditStocktakeModal
        open={editOpen}
        stocktake={row}
        onClose={() => setEditOpen(false)}
        onSaved={(next) => {
          detail.setData(next);
          syncedUpdatedAtRef.current = next.updatedAt;
        }}
      />
      {linesModal ? (
        <ManageStocktakeLinesModal
          open
          mode={linesModal}
          stocktake={row}
          onClose={() => setLinesModal(null)}
          onSaved={(next) => {
            detail.setData(next);
            syncedUpdatedAtRef.current = next.updatedAt;
            const synced = syncCountState(next);
            setCounts(synced.counts);
            setNotes(synced.notes);
            setConditions(synced.conditions);
            setReviews((prev) => {
              const merged: Record<string, ReviewDraft> = {};
              for (const [lineId, draft] of Object.entries(synced.reviews)) {
                merged[lineId] = {
                  ...draft,
                  selectedForRecount: prev[lineId]?.selectedForRecount ?? false,
                };
              }
              return merged;
            });
          }}
        />
      ) : null}
    </div>
  );
}
