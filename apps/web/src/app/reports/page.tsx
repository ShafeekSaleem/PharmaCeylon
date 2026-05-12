"use client";

import { useEffect, useState } from "react";
import { PmsNav } from "@/components/pms-nav";
import { apiJson } from "@/lib/auth-client";
import { useRequireAuth } from "@/lib/use-require-auth";

export default function ReportsPage() {
  const { ready, isAuthenticated } = useRequireAuth();
  const [tab, setTab] = useState<"sales" | "margin" | "expiry" | "dead">("sales");
  const [out, setOut] = useState<unknown>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!ready || !isAuthenticated) return;
    const path =
      tab === "sales"
        ? "/reports/sales-summary"
        : tab === "margin"
          ? "/reports/margin-by-product"
          : tab === "expiry"
            ? "/reports/near-expiry"
            : "/reports/dead-stock";
    setErr(null);
    setOut(null);
    apiJson(path)
      .then(setOut)
      .catch((e) => setErr(e instanceof Error ? e.message : "Failed"));
  }, [ready, isAuthenticated, tab]);

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
        maxWidth: 900,
        margin: "0 auto",
      }}
    >
      <PmsNav />
      <h1 style={{ marginTop: 0 }}>Reports</h1>
      <p style={{ color: "#555", fontSize: "0.9rem" }}>Select a branch on the Dashboard.</p>
      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        {(
          [
            ["sales", "Sales summary"],
            ["margin", "Margin by product"],
            ["expiry", "Near expiry"],
            ["dead", "Dead stock"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            style={{
              padding: "0.35rem 0.75rem",
              cursor: "pointer",
              fontWeight: tab === k ? 700 : 400,
              border: tab === k ? "2px solid #2563eb" : "1px solid #ccc",
              borderRadius: 6,
              background: tab === k ? "#eff6ff" : "#fff",
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {err ? <p style={{ color: "#b91c1c" }}>{err}</p> : null}
      <pre
        style={{
          background: "#f4f4f5",
          padding: "0.75rem",
          borderRadius: 6,
          fontSize: "0.85rem",
          overflow: "auto",
        }}
      >
        {out ? JSON.stringify(out, null, 2) : "Loading…"}
      </pre>
    </main>
  );
}
