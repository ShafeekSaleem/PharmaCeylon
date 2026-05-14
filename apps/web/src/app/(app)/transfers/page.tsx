"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import { apiJson } from "@/lib/auth-client";

type TransferRow = {
  id: string;
  status: string;
  fromBranchId: string;
  toBranchId: string;
};

export default function TransfersPage() {
  const [rows, setRows] = useState<TransferRow[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    apiJson<TransferRow[]>("/transfers")
      .then(setRows)
      .catch((e) => setErr(e instanceof Error ? e.message : "Failed (branch required)"));
  }, []);

  return (
    <div style={{ maxWidth: 800 }}>
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
    </div>
  );
}
