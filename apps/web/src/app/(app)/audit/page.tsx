"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import { apiJson } from "@/lib/auth-client";

type AuditRow = {
  id: string;
  eventName: string;
  entityName: string;
  entityId: string;
  createdAt: string;
  payload: unknown;
};

export default function AuditPage() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    apiJson<AuditRow[]>("/audit/events?take=80")
      .then(setRows)
      .catch((e) => setErr(e instanceof Error ? e.message : "Failed"));
  }, []);

  return (
    <div style={{ maxWidth: 960 }}>
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
    </div>
  );
}
