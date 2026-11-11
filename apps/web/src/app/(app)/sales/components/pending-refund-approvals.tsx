"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { DailyWorkItem } from "@pharmaceylon/shared";
import { Alert } from "@/components/alert";
import { RolePageGuard } from "@/components/role-access";
import {
  ActionButton,
  ApprovalEvidencePanel,
  CounterHandoff,
  DataTable,
  Modal,
  ModalFooter,
  PageHeader,
  type Column,
} from "@/components/ui";
import { apiJson } from "@/lib/auth-client";
import { formatMoney } from "@/lib/money";
import { usePermissions } from "@/lib/permissions";
import { useAuth } from "@/lib/use-auth";
import type { SaleRefundRequest } from "../types";
import { PAYMENT_METHOD_LABELS } from "../constants";
import { formatDateTime } from "../utils";
import css from "../sales.module.css";
import styles from "./pending-refund-approvals.module.css";

type QueueRow = DailyWorkItem;
type QueuePage = {
  items: QueueRow[];
  total: number;
  page: number;
  pageSize: number;
};
const PAGE_SIZE = 25;

export default function PendingRefundApprovals() {
  const { branchId } = useAuth();
  return (
    <RolePageGuard permissions={["returns.approve"]}>
      <Suspense fallback={null}>
        {branchId ? (
          <RefundQueue key={branchId} branchId={branchId} />
        ) : (
          <p>Select a branch to review refunds.</p>
        )}
      </Suspense>
    </RolePageGuard>
  );
}

function RefundQueue({ branchId }: { branchId: string }) {
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const {
    canSelfApprove,
    permissionKeys,
    loading: permissionsLoading,
  } = usePermissions();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<QueuePage>({
    items: [],
    total: 0,
    page: 1,
    pageSize: PAGE_SIZE,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(
    searchParams.get("request"),
  );
  const [review, setReview] = useState<SaleRefundRequest | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const listGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const submitting = useRef(false);
  const approvalIds = useRef(new Map<string, string>());
  // Every request pins the branch it was reviewed at, including after a top-bar branch switch.
  const headers = useCallback(() => ({ "x-branch-id": branchId }), [branchId]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search.trim());
      setPage(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    setSelected(searchParams.get("request"));
  }, [searchParams]);

  const reload = useCallback(async () => {
    const generation = ++listGeneration.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(PAGE_SIZE),
        q: query,
        kind: "sale_refund.approve",
        filter: "all",
      });
      const next = await apiJson<QueuePage>(
        `/dashboard/work?${params}`,
        { headers: headers() },
      );
      if (!alive.current || generation !== listGeneration.current) return;
      if (
        page > 1 &&
        !next.items.length &&
        next.total <= (page - 1) * PAGE_SIZE
      ) {
        setPage(Math.max(1, Math.ceil(next.total / PAGE_SIZE)));
      } else setData(next);
    } catch (err) {
      if (!alive.current || generation !== listGeneration.current) return;
      setError(
        err instanceof Error ? err.message : "Couldn't load refund approvals",
      );
      setData({ items: [], total: 0, page, pageSize: PAGE_SIZE });
    } finally {
      if (alive.current && generation === listGeneration.current)
        setLoading(false);
    }
  }, [headers, page, query]);
  useEffect(() => {
    void reload();
  }, [reload]);
  // Refresh when returning from the counter or another page; explicit Refresh is also available.
  useEffect(() => {
    const onFocus = () => {
      if (!submitting.current) void reload();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reload]);

  const loadReview = useCallback(
    async (id: string) => {
      const generation = ++detailGeneration.current;
      setReview(null);
      setReviewLoading(true);
      setReviewError(null);
      try {
        const next = await apiJson<SaleRefundRequest>(
          `/sales/refund-requests/${encodeURIComponent(id)}`,
          { headers: headers() },
        );
        if (alive.current && generation === detailGeneration.current)
          setReview(next);
      } catch (err) {
        if (alive.current && generation === detailGeneration.current)
          setReviewError(
            err instanceof Error ? err.message : "Couldn't load this refund",
          );
      } finally {
        if (alive.current && generation === detailGeneration.current)
          setReviewLoading(false);
      }
    },
    [headers],
  );
  useEffect(() => {
    if (selected) void loadReview(selected);
    else {
      detailGeneration.current++;
      setReview(null);
      setReviewError(null);
    }
  }, [loadReview, selected]);

  async function approve() {
    if (!review?.approvalReview || submitting.current) return;
    const captured = review;
    const slot = `${captured.id}:${captured.approvalReview!.expectedVersion}:${captured.approvalReview!.expectedDigest}`;
    const approvalId = approvalIds.current.get(slot) ?? crypto.randomUUID();
    approvalIds.current.set(slot, approvalId);
    submitting.current = true;
    setBusy(true);
    setReviewError(null);
    try {
      const approved = await apiJson<SaleRefundRequest>(
        `/sales/refund-requests/${captured.id}/approve`,
        {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ approvalId, ...captured.approvalReview }),
        },
      );
      if (!alive.current) return;
      setReview(approved);
      setNotice(
        `${approved.requestNumber} approved. The refund is waiting at the counter.`,
      );
      await reload();
    } catch (err) {
      if (!alive.current) return;
      // Discard old evidence: a stale/cancelled/permission refusal requires a fresh review.
      await loadReview(captured.id);
      if (!alive.current) return;
      setReviewError(
        err instanceof Error ? err.message : "Couldn't approve this refund",
      );
      await reload();
    } finally {
      submitting.current = false;
      if (alive.current) setBusy(false);
    }
  }

  const columns: Column<QueueRow>[] = [
    { key: "reference", header: "Refund", render: row => <strong>{row.reference}</strong> },
    { key: "detail", header: "Invoice / amount", render: row => row.detail },
    { key: "requested", header: "Requested", render: row => formatDateTime(row.createdAt) },
    { key: "review", header: "Status", render: row => row.blocked ? "Another approver needed" : "Pending approval" },
  ];
  const open = review?.status === "prepared" || review?.status === "approved";
  const selfBlocked = review?.requester?.id === user?.id && !canSelfApprove;
  const mayApprove =
    open &&
    !review?.readyAtCounter &&
    !selfBlocked &&
    !permissionsLoading &&
    permissionKeys.includes("returns.approve");

  return (
    <div className={css.page}>
      <PageHeader
        subtitleOnly
        description="Pending refund approvals for this branch, from Daily work. Review the request here; approved refunds wait at the counter."
      />
      {error && <Alert variant="error">{error}</Alert>}
      {notice && <p role="status">{notice}</p>}
      <div className={css.toolbar}>
        <input
          className={css.searchInput}
          type="search"
          aria-label="Search refund or invoice number"
          placeholder="Refund or invoice number…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <ActionButton
          variant="secondary"
          onClick={() => void reload()}
          disabled={loading || busy}
        >
          Refresh
        </ActionButton>
        <span role="status">
          {loading
            ? "Loading approvals…"
            : `${data.total} waiting for approval`}
        </span>
      </div>
      <DataTable
        columns={columns}
        data={data.items}
        rowKey={(row) => row.id}
        loading={loading}
        page={page}
        pageSize={PAGE_SIZE}
        total={data.total}
        onPageChange={setPage}
        onRowClick={(row) => {
          setSelected(row.id.slice(row.id.indexOf(":") + 1));
          setNotice(null);
        }}
        emptyTitle={query ? "No matching refunds" : "No refunds need approval"}
        emptyDescription={
          query
            ? "Try another refund or invoice number."
            : "Over-threshold refunds appear here when staff prepare them."
        }
      />
      <Modal
        open={!!selected}
        title={review ? `Review ${review.requestNumber}` : "Review refund"}
        onClose={() => setSelected(null)}
        canDismiss={!busy}
        size="lg"
        footer={
          <ModalFooter>
            <ActionButton
              variant="secondary"
              disabled={busy}
              onClick={() => setSelected(null)}
            >
              Close
            </ActionButton>
            {mayApprove && review?.approvalReview && (
              <ActionButton
                disabled={busy || reviewLoading}
                onClick={() => void approve()}
              >
                {busy ? "Approving…" : "Approve refund"}
              </ActionButton>
            )}
          </ModalFooter>
        }
      >
        {reviewLoading && <p role="status">Loading refund…</p>}
        {reviewError && <Alert variant="error">{reviewError}</Alert>}
        {!reviewLoading && !review && selected && (
          <ActionButton
            variant="secondary"
            onClick={() => void loadReview(selected)}
          >
            Retry
          </ActionButton>
        )}
        {review && (
          <div className={styles.review}>
            <div className={css.summaryRow}>
              <span>{review.invoiceNo ?? "Invoice unavailable"}</span>
              <strong>{formatMoney(review.amount)}</strong>
            </div>
            <p>
              <strong>Reason:</strong> {review.reason}
            </p>
            <p>
              <strong>Refund method:</strong>{" "}
              {review.refundMethod
                ? PAYMENT_METHOD_LABELS[review.refundMethod]
                : "Original payment method(s)"}
            </p>
            <div className={styles.lines}>
              <table className={css.receiptTable}>
                <thead>
                  <tr>
                    <th>Product / batch</th>
                    <th>Units</th>
                    <th>Paid per unit</th>
                    <th>Returned stock</th>
                  </tr>
                </thead>
                <tbody>
                  {review.lines.map((line, index) => (
                    <tr key={`${line.productId}:${line.batchId}:${index}`}>
                      <td data-label="Product / batch">
                        {line.productName ?? line.productId}
                        <div className={css.cellSub}>
                          Batch {line.batchNo ?? line.batchId}
                        </div>
                      </td>
                      <td data-label="Units">{line.qty}</td>
                      <td data-label="Paid per unit">
                        {formatMoney(line.unitPrice)}
                      </td>
                      <td data-label="Returned stock">
                        {line.disposition === "quarantine"
                          ? "Quarantine"
                          : "Restock"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ApprovalEvidencePanel
              title="Refund approval"
              currentVersion={review.approvalVersion}
              approvedVersion={
                review.executionApprovalId ? review.approvalVersion : null
              }
              status={review.status}
              statusLabel={
                !open
                  ? review.status === "executed"
                    ? "Already refunded"
                    : "Cancelled"
                  : review.readyAtCounter
                    ? "Waiting at the counter"
                    : review.approvalRevoked
                      ? "Needs fresh approval"
                      : "Needs approval"
              }
              requester={
                review.requester
                  ? { name: review.requester.fullName, at: review.requestedAt }
                  : null
              }
              approver={
                review.approver
                  ? { name: review.approver.fullName, at: review.approvedAt }
                  : null
              }
              executor={
                review.executor
                  ? { name: review.executor.fullName, at: review.executedAt }
                  : null
              }
            />
            {selfBlocked && open && !review.readyAtCounter && (
              <p>You raised this refund. Another approver must review it.</p>
            )}
            {open && review.readyAtCounter && (
              <CounterHandoff
                branchName="this branch"
                action="Refund the customer"
                whoCan={["Cashier", "Pharmacist", "Manager"]}
              />
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
