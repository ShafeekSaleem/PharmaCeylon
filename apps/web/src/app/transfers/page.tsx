"use client";

import { useEffect, useState } from "react";
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
      <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
        Loading…
      </main>
    );
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        padding: "1.5rem",
        fontFamily: "system-ui, sans-serif",
        maxWidth: 800,
        margin: "0 auto",
      }}
    >
      <PmsNav />
      <h1 style={{ marginTop: 0 }}>Transfers</h1>
      <p style={{ color: "#555", fontSize: "0.9rem" }}>
        Listing for the active branch. Create/approve/ship/receive via API or extend this UI later.
      </p>
      {err ? <p style={{ color: "#b91c1c" }}>{err}</p> : null}
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
