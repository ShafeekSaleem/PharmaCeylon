"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import { PmsNav } from "@/components/pms-nav";
import { apiJson } from "@/lib/auth-client";
import { useRequireAuth } from "@/lib/use-require-auth";

type TransferRow = {
  id: string;
  status: string;
  fromBranchId: string;
  toBranchId: string;
};

export default function TransfersPage() {
  const { ready, isAuthenticated } = useRequireAuth();
  const [rows, setRows] = useState<TransferRow[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!ready || !isAuthenticated) return;
    apiJson<TransferRow[]>("/transfers")
      .then(setRows)
      .catch((e) => setErr(e instanceof Error ? e.message : "Failed (branch required)"));
  }, [ready, isAuthenticated]);

  if (!ready || !isAuthenticated) {
    return (
      <main className="pc-app-main">
        <p className="pc-muted">Loading…</p>
      </main>
    );
  }

  return (
    <main className="pc-app-main" style={{ maxWidth: 800 }}>
      <PmsNav />
      <h1 style={{ marginTop: 0, color: "var(--pc-foreground)" }}>Transfers</h1>
      <p className="pc-muted" style={{ fontSize: "0.9rem" }}>
        Listing for the active branch. Create/approve/ship/receive via API or extend this UI later.
      </p>
      {err ? <Alert variant="error">{err}</Alert> : null}
      <ul style={{ paddingLeft: "1.1rem" }}>
        {rows.map((t) => (
          <li key={t.id} style={{ marginBottom: 6 }}>
            <code>{t.id.slice(0, 8)}…</code> — {t.status} (from {t.fromBranchId.slice(0, 8)}… → to{" "}
            {t.toBranchId.slice(0, 8)}…)
          </li>
        ))}
      </ul>
    </main>
  );
}
