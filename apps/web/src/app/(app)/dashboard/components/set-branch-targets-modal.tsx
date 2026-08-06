"use client";

import { useEffect, useMemo, useState } from "react";
import { apiJson } from "@/lib/auth-client";
import { formatMoney } from "@/app/(app)/inventory/utils";
import type { BranchPerformanceRow } from "../hooks/use-dashboard-data";
import css from "../dashboard.module.css";

type AdminUser = {
  id: string;
  fullName: string;
  email: string;
  isActive: boolean;
  userBranchRoles: Array<{ branchId: string; role: string }>;
};

type DraftRow = {
  branchId: string;
  targetAmount: string;
  managerUserId: string;
};

type Props = {
  open: boolean;
  yearMonth: string;
  branches: BranchPerformanceRow[];
  onClose: () => void;
  onSaved: () => void;
};

export function SetBranchTargetsModal({
  open,
  yearMonth,
  branches,
  onClose,
  onSaved,
}: Props) {
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [managers, setManagers] = useState<AdminUser[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDrafts(
      branches.map((b) => ({
        branchId: b.branchId,
        targetAmount:
          b.targetAmount != null ? String(Math.round(b.targetAmount)) : "",
        managerUserId: b.manager?.id ?? "",
      })),
    );
    setError(null);
    void apiJson<AdminUser[]>("/admin/users")
      .then((users) =>
        setManagers(
          users.filter(
            (u) =>
              u.isActive &&
              u.userBranchRoles.some((r) => r.role === "manager"),
          ),
        ),
      )
      .catch(() => setManagers([]));
  }, [open, branches]);

  const managersByBranch = useMemo(() => {
    const map = new Map<string, AdminUser[]>();
    for (const b of branches) {
      map.set(
        b.branchId,
        managers.filter((m) =>
          m.userBranchRoles.some(
            (r) => r.branchId === b.branchId && r.role === "manager",
          ),
        ),
      );
    }
    return map;
  }, [branches, managers]);

  if (!open) return null;

  async function saveAll() {
    setSaving(true);
    setError(null);
    try {
      for (const row of drafts) {
        const amount = Number(row.targetAmount);
        if (!Number.isFinite(amount) || amount < 0) {
          throw new Error("Enter a valid target amount for every branch.");
        }
        await apiJson("/analytics/branch-monthly-targets", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            branchId: row.branchId,
            yearMonth,
            targetAmount: amount,
            managerUserId: row.managerUserId || null,
          }),
        });
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save targets");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={css.modalBackdrop} role="presentation" onClick={onClose}>
      <div
        className={css.modalCard}
        role="dialog"
        aria-modal="true"
        aria-labelledby="set-targets-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={css.modalHeader}>
          <div>
            <h2 id="set-targets-title" className={css.modalTitle}>
              Set branch targets
            </h2>
            <p className={css.muted}>
              Monthly sales targets for {yearMonth}. Assign a manager for
              performance tracking.
            </p>
          </div>
          <button type="button" className={css.modalClose} onClick={onClose}>
            Close
          </button>
        </div>

        <div className={css.modalBody}>
          <table className={css.salesTable}>
            <thead>
              <tr>
                <th>Branch</th>
                <th>MTD sales</th>
                <th>Target (LKR)</th>
                <th>Manager</th>
              </tr>
            </thead>
            <tbody>
              {branches.map((b) => {
                const draft = drafts.find((d) => d.branchId === b.branchId);
                const opts = managersByBranch.get(b.branchId) ?? [];
                return (
                  <tr key={b.branchId}>
                    <td>
                      <div>{b.name}</div>
                      <span className={css.muted}>{b.city ?? b.code}</span>
                    </td>
                    <td>{formatMoney(b.monthSales)}</td>
                    <td>
                      <input
                        className={css.targetInput}
                        inputMode="decimal"
                        value={draft?.targetAmount ?? ""}
                        onChange={(e) =>
                          setDrafts((rows) =>
                            rows.map((r) =>
                              r.branchId === b.branchId
                                ? { ...r, targetAmount: e.target.value }
                                : r,
                            ),
                          )
                        }
                      />
                    </td>
                    <td>
                      <select
                        className={css.targetSelect}
                        value={draft?.managerUserId ?? ""}
                        onChange={(e) =>
                          setDrafts((rows) =>
                            rows.map((r) =>
                              r.branchId === b.branchId
                                ? { ...r, managerUserId: e.target.value }
                                : r,
                            ),
                          )
                        }
                      >
                        <option value="">Unassigned</option>
                        {opts.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.fullName}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {error ? <p className={css.formError}>{error}</p> : null}
        </div>

        <div className={css.modalFooter}>
          <button type="button" className={css.btnGhost} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={css.btnPrimary}
            disabled={saving}
            onClick={() => void saveAll()}
          >
            {saving ? "Saving…" : "Save targets"}
          </button>
        </div>
      </div>
    </div>
  );
}
