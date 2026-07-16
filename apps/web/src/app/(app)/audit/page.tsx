"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
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

function AuditPageContent() {
  const searchParams = useSearchParams();
  const entityName = searchParams.get("entityName");
  const entityId = searchParams.get("entityId");
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setErr(null);
    const params = new URLSearchParams({ take: "80" });
    if (entityName) params.set("entityName", entityName);
    if (entityId) params.set("entityId", entityId);
    apiJson<AuditRow[]>(`/audit/events?${params}`)
      .then(setRows)
      .catch((e) => setErr(e instanceof Error ? e.message : "Failed"))
      .finally(() => setLoading(false));
  }, [entityName, entityId]);

  const filtered = entityName && entityId;

  return (
    <div style={{ maxWidth: 960 }}>
      <h1 style={{ marginTop: 0, color: "var(--pc-foreground)" }}>Audit trail</h1>
      {filtered && (
        <p style={{ color: "var(--pc-muted-fg)", fontSize: "0.9rem", marginTop: "-0.25rem" }}>
          Filtered to <strong>{entityName}</strong> ·{" "}
          <code style={{ fontSize: "0.85rem" }}>{entityId}</code>
        </p>
      )}
      {err ? <Alert variant="error">{err}</Alert> : null}
      {loading ? (
        <p style={{ color: "var(--pc-muted-fg)" }}>Loading…</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid var(--pc-border)" }}>
              <th style={{ padding: "0.4rem", color: "var(--pc-muted-fg)" }}>When</th>
              <th style={{ padding: "0.4rem", color: "var(--pc-muted-fg)" }}>Event</th>
              <th style={{ padding: "0.4rem", color: "var(--pc-muted-fg)" }}>Entity</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={3} style={{ padding: "1rem", color: "var(--pc-muted-fg)" }}>
                  No audit events found.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id} style={{ borderBottom: "1px solid var(--pc-border)" }}>
                  <td style={{ padding: "0.4rem", whiteSpace: "nowrap" }}>
                    {new Date(r.createdAt).toLocaleString()}
                  </td>
                  <td style={{ padding: "0.4rem" }}>{r.eventName}</td>
                  <td style={{ padding: "0.4rem" }}>
                    {r.entityName}{" "}
                    <code style={{ fontSize: "0.8rem" }}>{r.entityId.slice(0, 8)}…</code>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function AuditPage() {
  return (
    <Suspense fallback={<p style={{ color: "var(--pc-muted-fg)" }}>Loading…</p>}>
      <AuditPageContent />
    </Suspense>
  );
}
