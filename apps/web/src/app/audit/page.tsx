"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import { PmsNav } from "@/components/pms-nav";
import { apiJson } from "@/lib/auth-client";
import { useRequireAuth } from "@/lib/use-require-auth";

type AuditRow = {
  id: string;
  eventName: string;
  entityName: string;
  entityId: string;
  createdAt: string;
  payload: unknown;
};

export default function AuditPage() {
  const { ready, isAuthenticated } = useRequireAuth();
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!ready || !isAuthenticated) return;
    apiJson<AuditRow[]>("/audit/events?take=80")
      .then(setRows)
      .catch((e) => setErr(e instanceof Error ? e.message : "Failed"));
  }, [ready, isAuthenticated]);

  if (!ready || !isAuthenticated) {
    return (
      <main className="pc-app-main">
        <p className="pc-muted">Loading…</p>
      </main>
    );
  }

  return (
    <main className="pc-app-main" style={{ maxWidth: 960 }}>
      <PmsNav />
      <h1 style={{ marginTop: 0, color: "var(--pc-foreground)" }}>Audit trail</h1>
      {err ? <Alert variant="error">{err}</Alert> : null}
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid var(--pc-border)" }}>
            <th style={{ padding: "0.4rem", color: "var(--pc-muted-fg)" }}>When</th>
            <th style={{ padding: "0.4rem", color: "var(--pc-muted-fg)" }}>Event</th>
            <th style={{ padding: "0.4rem", color: "var(--pc-muted-fg)" }}>Entity</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} style={{ borderBottom: "1px solid var(--pc-border)" }}>
              <td style={{ padding: "0.4rem", whiteSpace: "nowrap" }}>{new Date(r.createdAt).toLocaleString()}</td>
              <td style={{ padding: "0.4rem" }}>{r.eventName}</td>
              <td style={{ padding: "0.4rem" }}>
                {r.entityName}{" "}
                <code style={{ fontSize: "0.8rem" }}>{r.entityId.slice(0, 8)}…</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
