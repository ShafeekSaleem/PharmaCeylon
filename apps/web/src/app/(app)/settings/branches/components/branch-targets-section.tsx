"use client";

import { useEffect, useMemo, useState } from "react";
import { Alert } from "@/components/alert";
import { ActionButton, FormField, SelectField } from "@/components/ui";
import { IconTarget } from "@/components/icons";
import { apiJson } from "@/lib/auth-client";
import { formatMoney } from "@/app/(app)/inventory/utils";
import css from "../../settings.module.css";

type BranchTargetRow = {
  branchId: string;
  code: string;
  name: string;
  city: string | null;
  monthSales: number;
  targetAmount: number | null;
  manager: { id: string; fullName: string; email: string } | null;
};

type AdminUser = {
  id: string;
  fullName: string;
  email: string;
  isActive: boolean;
  userBranchRoles: Array<{ branchId: string; role: string }>;
};

type DraftRow = { branchId: string; targetAmount: string; managerUserId: string };

function currentYearMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/** Owner-only monthly sales targets + manager assignment per branch — moved here from a
 * dashboard-widget modal so it lives with the rest of branch configuration. */
export function BranchTargetsSection() {
  const yearMonth = useMemo(() => currentYearMonth(), []);
  const [branches, setBranches] = useState<BranchTargetRow[]>([]);
  const [managers, setManagers] = useState<AdminUser[]>([]);
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void Promise.all([
      apiJson<{ branches: BranchTargetRow[] }>(`/analytics/branch-performance?yearMonth=${yearMonth}`),
      apiJson<AdminUser[]>("/admin/users"),
    ])
      .then(([perf, users]) => {
        if (cancelled) return;
        setBranches(perf.branches);
        setDrafts(
          perf.branches.map((b) => ({
            branchId: b.branchId,
            targetAmount: b.targetAmount != null ? String(Math.round(b.targetAmount)) : "",
            managerUserId: b.manager?.id ?? "",
          })),
        );
        setManagers(users.filter((u) => u.isActive && u.userBranchRoles.some((r) => r.role === "manager")));
      })
      .catch(() => {
        if (!cancelled) setError("Failed to load branch targets.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [yearMonth]);

  const managersByBranch = useMemo(() => {
    const map = new Map<string, AdminUser[]>();
    for (const b of branches) {
      map.set(
        b.branchId,
        managers.filter((m) => m.userBranchRoles.some((r) => r.branchId === b.branchId && r.role === "manager")),
      );
    }
    return map;
  }, [branches, managers]);

  function updateDraft(branchId: string, patch: Partial<DraftRow>) {
    setSaved(false);
    setDrafts((rows) => rows.map((r) => (r.branchId === branchId ? { ...r, ...patch } : r)));
  }

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
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save targets.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={css.card} id="targets">
      <div className={css.cardHead}>
        <div>
          <h2 className={css.cardTitle}>
            <IconTarget size={16} /> Monthly Sales Targets
          </h2>
          <p className={css.cardDesc}>
            Targets for {yearMonth}. Assign a manager per branch for performance tracking on the dashboard.
          </p>
        </div>
      </div>

      {error ? <Alert variant="error">{error}</Alert> : null}
      {saved ? <Alert variant="success">Targets saved.</Alert> : null}

      {loading ? (
        <p className={css.rowHint}>Loading branch targets…</p>
      ) : branches.length === 0 ? (
        <p className={css.rowHint}>No branches to show.</p>
      ) : (
        <>
          {branches.map((b) => {
            const draft = drafts.find((d) => d.branchId === b.branchId);
            const opts = managersByBranch.get(b.branchId) ?? [];
            return (
              <div key={b.branchId} className={css.rowItem} style={{ alignItems: "flex-start" }}>
                <div>
                  <div className={css.rowLabel}>{b.name}</div>
                  <div className={css.rowHint}>
                    {b.city ?? b.code} · MTD sales {formatMoney(b.monthSales)}
                  </div>
                </div>
                <div className={css.formGrid} style={{ maxWidth: 420, flexShrink: 0 }}>
                  <FormField
                    label="Target (LKR)"
                    inputMode="decimal"
                    value={draft?.targetAmount ?? ""}
                    onChange={(e) => updateDraft(b.branchId, { targetAmount: e.target.value })}
                  />
                  <SelectField
                    label="Manager"
                    value={draft?.managerUserId ?? ""}
                    onChange={(v) => updateDraft(b.branchId, { managerUserId: v })}
                    options={[{ value: "", label: "Unassigned" }, ...opts.map((m) => ({ value: m.id, label: m.fullName }))]}
                  />
                </div>
              </div>
            );
          })}
          <div className={css.saveRow}>
            <ActionButton onClick={() => void saveAll()} disabled={saving}>
              {saving ? "Saving…" : "Save targets"}
            </ActionButton>
          </div>
        </>
      )}
    </div>
  );
}
