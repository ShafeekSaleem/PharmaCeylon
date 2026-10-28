"use client";

import { useEffect, useState, type ReactNode } from "react";
import { validateCounterPolicy, type CounterPolicyView } from "@pharmaceylon/shared";
import { Alert } from "@/components/alert";
import { ActionButton } from "@/components/ui";
import { apiJson } from "@/lib/auth-client";
import { useAuth } from "@/lib/use-auth";
import css from "../settings.module.css";

export type CounterPolicyEditor = {
  view: CounterPolicyView;
  disabled: boolean;
  edit: (policy: CounterPolicyView["policy"]) => void;
};

type SectionProps = {
  /** Card title; the branch name is appended once loaded. */
  title: string;
  saveLabel: string;
  description?: ReactNode;
  children: (editor: CounterPolicyEditor) => ReactNode;
};

/**
 * One branch's counter policy document, edited from several settings pages (counters, payments,
 * offline). Each page saves the whole document with the version it loaded, so two pages edited
 * at once can't overwrite each other: the second save is refused and asks for a reload.
 */
export function CounterPolicySection(props: SectionProps) {
  const { branchId } = useAuth();
  // The key discards an unsaved draft on branch switches. The editor also cancels old reads
  // so a slow response cannot install branch A's policy in branch B's form.
  return branchId ? (
    <BranchPolicyEditor key={branchId} branchId={branchId} {...props} />
  ) : (
    <p>Choose a branch to manage its counter settings.</p>
  );
}

function BranchPolicyEditor({
  branchId,
  title,
  saveLabel,
  description,
  children,
}: SectionProps & { branchId: string }) {
  const [view, setView] = useState<CounterPolicyView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const endpoint = `/tenant/branches/${branchId}/counter-policy`;

  useEffect(() => {
    let cancelled = false;
    apiJson<CounterPolicyView>(endpoint).then(
      (result) => {
        if (!cancelled) setView(result);
      },
      (err) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "Couldn't load counter settings.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [endpoint]);

  function edit(policy: CounterPolicyView["policy"]) {
    setView((current) => current && { ...current, policy });
    setSaved(false);
  }

  async function save() {
    if (!view) return;
    const parsed = validateCounterPolicy(view.policy);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const result = await apiJson<CounterPolicyView>(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: view.version, policy: parsed.value }),
      });
      setView(result);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save counter settings.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={css.card} aria-label={title}>
      <h2 className={css.cardTitle}>
        {title}
        {view ? ` — ${view.branchName}` : ""}
      </h2>
      {description}
      {error ? <Alert variant="error">{error}</Alert> : null}
      {saved ? <p role="status">Saved.</p> : null}
      {view ? (
        <>
          {children({ view, disabled: !view.canEdit || saving, edit })}
          {view.canEdit ? (
            <div className={css.saveRow}>
              <ActionButton onClick={save} disabled={saving}>
                {saving ? "Saving…" : saveLabel}
              </ActionButton>
            </div>
          ) : null}
        </>
      ) : !error ? (
        <p>Loading counter settings…</p>
      ) : null}
    </section>
  );
}

/** D-W7 wording for every setting that feeds an offline grant or stock snapshot. */
export function SyncNote({ children }: { children?: ReactNode }) {
  return (
    <p className={css.rowHint}>
      Applies to counters after their next sync.{children ? <> {children}</> : null}
    </p>
  );
}
