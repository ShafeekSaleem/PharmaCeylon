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
import { CaseDetail, PLAN_LABELS, REVIEW_PERMISSION, when } from "./case-detail";
import type { StockCaseDetail, StockCaseSummary } from "./types";
import css from "./stock-cases.module.css";

/**
 * P5 #51, revised D10: offline sales whose stock could not post when they synced. A manager
 * reviews the evidence and approves exactly how each case is resolved; the count, correction and
 * posting happen at the branch's counter in PharmaCeylon POS. Nothing here moves stock.
 */
function StockCasesPage() {
  const router = useRouter();
  const params = useSearchParams();
  const { branchId, user } = useAuth();
  const { permissionKeys, canSelfApprove } = usePermissions();
  const mayReview = permissionKeys.includes(REVIEW_PERMISSION);

  const [status, setStatus] = useState<"open" | "resolved">("open");
  const [cases, setCases] = useState<StockCaseSummary[] | null>(null);
  const [detail, setDetail] = useState<StockCaseDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const selectedId = params.get("caseId") ?? cases?.[0]?.id ?? null;

  const loadList = useCallback(async () => {
    if (!branchId || !mayReview) return;
    try {
      setCases(await apiJson<StockCaseSummary[]>(`/offline-stock-cases?status=${status}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load stock cases");
    }
  }, [branchId, mayReview, status]);

  const loadDetail = useCallback(async () => {
    if (!selectedId || !mayReview) {
      setDetail(null);
      return;
    }
    try {
      setDetail(await apiJson<StockCaseDetail>(`/offline-stock-cases/${encodeURIComponent(selectedId)}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load this case");
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
        description="Offline sales whose stock could not be posted when the counter synced. Review the evidence and approve how each is resolved; the count and correction happen at the counter."
      />
      <InventorySubnav />
      {error ? <Alert variant="error">{error}</Alert> : null}
      {!branchId ? (
        <div className={css.empty}>Select a branch in the header to review its stock cases.</div>
      ) : (
        <div className={css.layout}>
          <div>
            <div className={css.filters} role="group" aria-label="Which cases">
              {(["open", "resolved"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  className={css.filter}
                  aria-pressed={status === s}
                  onClick={() => {
                    setStatus(s);
                    router.replace("/inventory/stock-cases");
                  }}
                >
                  {s === "open" ? "Open" : "Resolved"}
                </button>
              ))}
            </div>
            <ul className={css.list} aria-label="Stock cases">
              {(cases ?? []).map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    className={css.item}
                    aria-current={c.id === selectedId ? "true" : undefined}
                    onClick={() => router.replace(`/inventory/stock-cases?caseId=${c.id}`)}
                  >
                    <strong>
                      {c.invoiceNo} · {c.pendingUnits} unit(s) pending
                    </strong>
                    <span className={css.sub}>
                      {c.counter ?? "Offline counter"} · sold {when(c.soldAt)}
                      {c.shortfallUnits > 0 ? ` · ${c.shortfallUnits} short` : ""}
                    </span>
                    <span>
                      <StatusBadge
                        status={c.plan?.status ?? c.status}
                        label={c.plan ? PLAN_LABELS[c.plan.status] : c.status === "open" ? "Needs a plan" : "Resolved"}
                      />
                    </span>
                  </button>
                </li>
              ))}
              {cases && !cases.length ? (
                <li className={css.empty}>
                  {status === "open" ? "No offline sale is waiting on its stock." : "No resolved cases yet."}
                </li>
              ) : null}
            </ul>
          </div>
          {detail ? (
            <CaseDetail
              // A fresh plan form per case: a kind, note or link picked for one never carries over.
              key={detail.id}
              detail={detail}
              busy={busy}
              userId={user?.id ?? null}
              canSelfApprove={canSelfApprove}
              onPrepare={(body) => act(`/offline-stock-cases/${detail.id}/resolutions`, body)}
              onApprove={(plan, approvalId) =>
                act(`/offline-stock-cases/resolutions/${plan.id}/approve`, { approvalId, ...plan.approvalReview })
              }
              onCancel={(plan) => act(`/offline-stock-cases/resolutions/${plan.id}/cancel`)}
            />
          ) : (
            <div className={css.card}>
              <div className={css.empty}>Choose a case to review it.</div>
            </div>
          )}
        </div>
      )}
    </>
  );
}

export default function StockCasesRoute() {
  return (
    <RolePageGuard roles={OPERATIONS_ROLES} permissions={[REVIEW_PERMISSION]}>
      <Suspense fallback={null}>
        <StockCasesPage />
      </Suspense>
    </RolePageGuard>
  );
}
