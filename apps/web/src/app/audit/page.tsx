"use client";

import { useEffect, useState } from "react";
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
        maxWidth: 960,
        margin: "0 auto",
      }}
    >
      <PmsNav />
      <h1 style={{ marginTop: 0 }}>Audit trail</h1>
      {err ? <p style={{ color: "#b91c1c" }}>{err}</p> : null}
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
            <th style={{ padding: "0.4rem" }}>When</th>
            <th style={{ padding: "0.4rem" }}>Event</th>
            <th style={{ padding: "0.4rem" }}>Entity</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} style={{ borderBottom: "1px solid #f4f4f5" }}>
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
