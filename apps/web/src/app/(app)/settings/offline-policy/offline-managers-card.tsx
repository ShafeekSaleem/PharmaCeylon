"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { CounterGrantSettings, OfflineManagerAction } from "@pharmaceylon/shared";
import { Alert } from "@/components/alert";
import { apiJson } from "@/lib/auth-client";
import { useAuth } from "@/lib/use-auth";
import css from "../settings.module.css";
import { SyncNote } from "../lib/counter-policy";

const ACTION_LABELS: Record<OfflineManagerAction, string> = {
  acknowledge_business_hours: "After-hours selling",
  assist_shift_handover: "Shift handover",
};

/** Who a prepared offline counter will accept as its local manager, from role permissions. */
export function OfflineManagersCard({ refreshKey = 0 }: { refreshKey?: number }) {
  const { branchId } = useAuth();
  return branchId ? <Managers key={branchId} branchId={branchId} refreshKey={refreshKey} /> : null;
}

function Managers({ branchId, refreshKey }: { branchId: string; refreshKey: number }) {
  const [settings, setSettings] = useState<CounterGrantSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiJson<CounterGrantSettings>(`/tenant/branches/${branchId}/counter-settings`).then(
      (result) => {
        if (!cancelled) setSettings(result);
      },
      (err) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "Couldn't load offline managers.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [branchId, refreshKey]);

  return (
    <section className={css.card} aria-label="Offline managers">
      <h2 className={css.cardTitle}>Offline managers</h2>
      <p className={css.cardDesc}>
        While a counter is offline, only these staff can let selling continue past routine closing
        time, or count and close an absent cashier&apos;s shift. Each signs in with their own PIN,
        gives a reason, and can&apos;t override mandatory hours or the
        offline permission&apos;s expiry. Change who holds these in{" "}
        <Link href="/users/roles">Users &amp; Roles</Link> (&ldquo;Acknowledge after-hours selling
        offline&rdquo; and &ldquo;Close an absent cashier&apos;s shift offline&rdquo;).
      </p>
      <SyncNote>A manager must also be prepared on the counter itself.</SyncNote>
      {error ? <Alert variant="error">{error}</Alert> : null}
      {settings && !settings.offlineEnabled ? (
        <p className={css.rowHint}>
          Offline selling is off at this branch, so nobody acts as an offline manager until it is
          turned on.
        </p>
      ) : null}
      {settings ? (
        settings.offlineManagers.length === 0 ? (
          <p className={css.rowHint}>Nobody at this branch holds either permission.</p>
        ) : (
          settings.offlineManagers.map((staff) => (
            <div key={staff.userId} className={css.rowItem}>
              <span>{staff.name}</span>
              <span className={css.rowHint}>
                {staff.offlineManagerActions.map((a) => ACTION_LABELS[a]).join(" · ")}
              </span>
            </div>
          ))
        )
      ) : !error ? (
        <p className={css.rowHint}>Loading…</p>
      ) : null}
    </section>
  );
}
