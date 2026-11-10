"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import { RolePageGuard } from "@/components/role-access";
import { PageHeader, StatusBadge } from "@/components/ui";
import { apiJson } from "@/lib/auth-client";
import { usePermissions } from "@/lib/permissions";
import { OPERATIONS_ROLES } from "@/lib/role-access";
import { useAuth } from "@/lib/use-auth";
import { InventorySubnav } from "../components/inventory-subnav";
import { when } from "../stock-cases/case-detail";
import css from "../stock-cases/stock-cases.module.css";
import {
  KIND_LABELS,
  RecordDetail,
  REVIEW_PERMISSION,
  SETTLEMENT_LABELS,
  minor,
} from "./record-detail";
import type { RefusedRecordDetail, RefusedRecordSummary } from "./types";

/**
 * P5 #51 slice 4: offline records the server refused. Each one stops its counter from finishing
 * its sync until a manager decides: record it as it happened, or don't honour it. The decision is
 * exactly approved and settled here; a recorded sale's stock waits on a stock case.
 */
function OfflineRecordsPage() {
  const router = useRouter();
  const params = useSearchParams();
  const { branchId, user } = useAuth();
  const { permissionKeys, canSelfApprove } = usePermissions();
  const mayReview = permissionKeys.includes(REVIEW_PERMISSION);

  const [status, setStatus] = useState<"open" | "closed">("open");
  const [records, setRecords] = useState<RefusedRecordSummary[] | null>(null);
  const [detail, setDetail] = useState<RefusedRecordDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const selectedId = params.get("recordId") ?? records?.[0]?.id ?? null;

  const loadList = useCallback(async () => {
    if (!branchId || !mayReview) return;
    try {
      setRecords(
        await apiJson<RefusedRecordSummary[]>(
          `/offline-journal-reviews?status=${status}`,
        ),
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Couldn't load refused offline records",
      );
    }
  }, [branchId, mayReview, status]);

  const loadDetail = useCallback(async () => {
    if (!selectedId || !mayReview) {
      setDetail(null);
      return;
    }
    try {
      setDetail(
        await apiJson<RefusedRecordDetail>(
          `/offline-journal-reviews/${encodeURIComponent(selectedId)}`,
        ),
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Couldn't load this record",
      );
    }
  }, [selectedId, mayReview]);

  useEffect(() => {
    void loadList();
  }, [loadList]);
  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  async function act(path: string, body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      await apiJson(path, {
        method: "POST",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      await Promise.all([loadList(), loadDetail()]);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        subtitleOnly
        description="Offline records the server refused. Each one stops its counter from finishing its sync until a manager decides to record it as it happened or not honour it."
      />
      <InventorySubnav />
      {error ? <Alert variant="error">{error}</Alert> : null}
      {!branchId ? (
        <div className={css.empty}>
          Select a branch in the header to review its refused offline records.
        </div>
      ) : (
        <div className={css.layout}>
          <div>
            <div
              className={css.filters}
              role="group"
              aria-label="Which records"
            >
              {(["open", "closed"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  className={css.filter}
                  aria-pressed={status === s}
                  onClick={() => {
                    setStatus(s);
                    router.replace("/inventory/offline-records");
                  }}
                >
                  {s === "open" ? "Waiting" : "Settled"}
                </button>
              ))}
            </div>
            <ul className={css.list} aria-label="Refused offline records">
              {(records ?? []).map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    className={css.item}
                    aria-current={r.id === selectedId ? "true" : undefined}
                    onClick={() =>
                      router.replace(
                        `/inventory/offline-records?recordId=${r.id}`,
                      )
                    }
                  >
                    <strong>
                      {KIND_LABELS[r.kind]}
                      {r.totalMinor !== null ? ` · ${minor(r.totalMinor)}` : ""}
                    </strong>
                    <span className={css.sub}>
                      {r.counter ?? "Offline counter"} · record {r.sequence} ·{" "}
                      {when(r.occurredAt)}
                      {r.staff ? ` · ${r.staff}` : ""}
                    </span>
                    <span className={css.sub}>{r.refusal.explanation}</span>
                    <span>
                      <StatusBadge
                        status={
                          r.settlement?.status ??
                          (r.state === "open" ? "blocked" : "cancelled")
                        }
                        label={
                          r.settlement
                            ? SETTLEMENT_LABELS[r.settlement.status]
                            : r.state === "open"
                              ? "Needs a decision"
                              : "Overtaken"
                        }
                      />
                    </span>
                  </button>
                </li>
              ))}
              {records && !records.length ? (
                <li className={css.empty}>
                  {status === "open"
                    ? "No counter is waiting on a refused offline record."
                    : "Nothing settled yet."}
                </li>
              ) : null}
            </ul>
          </div>
          {detail ? (
            <RecordDetail
              // A fresh decision form per record: a choice or reason typed for one never carries over.
              key={detail.id}
              detail={detail}
              busy={busy}
              userId={user?.id ?? null}
              canSelfApprove={canSelfApprove}
              onPrepare={(body) =>
                act(`/offline-journal-reviews/${detail.id}/settlements`, body)
              }
              onApprove={(s, approvalId) =>
                act(`/offline-journal-reviews/settlements/${s.id}/approve`, {
                  approvalId,
                  ...s.approvalReview,
                })
              }
              onCancel={(s) =>
                act(`/offline-journal-reviews/settlements/${s.id}/cancel`)
              }
            />
          ) : (
            <div className={css.card}>
              <div className={css.empty}>Choose a record to review it.</div>
            </div>
          )}
        </div>
      )}
    </>
  );
}

export default function OfflineRecordsRoute() {
  return (
    <RolePageGuard roles={OPERATIONS_ROLES} permissions={[REVIEW_PERMISSION]}>
      <Suspense fallback={null}>
        <OfflineRecordsPage />
      </Suspense>
    </RolePageGuard>
  );
}
