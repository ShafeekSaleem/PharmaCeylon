"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Alert } from "@/components/alert";
import { apiJson } from "@/lib/auth-client";

type ReportTab = "sales" | "margin" | "expiry" | "dead";

function ReportsContent() {
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<ReportTab>("sales");
  const [out, setOut] = useState<unknown>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const t = searchParams.get("tab");
    if (t === "sales" || t === "margin" || t === "expiry" || t === "dead") {
      setTab(t);
    }
  }, [searchParams]);

  useEffect(() => {
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
  }, [tab]);

  return (
    <div style={{ maxWidth: 900 }}>
      <h1 style={{ marginTop: 0, color: "var(--pc-foreground)" }}>Reports</h1>
      <p className="pc-muted" style={{ fontSize: "0.9rem" }}>
        Select a branch on the Dashboard.
      </p>
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
              border: tab === k ? "2px solid var(--pc-primary)" : "1px solid var(--pc-border)",
              borderRadius: "var(--pc-radius-sm)",
              background: tab === k ? "var(--pc-primary-soft)" : "var(--pc-background)",
              color: "var(--pc-foreground)",
              fontFamily: "inherit",
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {err ? <Alert variant="error">{err}</Alert> : null}
      <pre className="pc-panel">{out ? JSON.stringify(out, null, 2) : "Loading…"}</pre>
    </div>
  );
}

export default function ReportsPage() {
  return (
    <Suspense fallback={<p className="pc-muted">Loading reports…</p>}>
      <ReportsContent />
    </Suspense>
  );
}
