"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import { PmsNav } from "@/components/pms-nav";
import { apiJson } from "@/lib/auth-client";
import { useRequireAuth } from "@/lib/use-require-auth";

export default function AnalyticsPage() {
  const { ready, isAuthenticated } = useRequireAuth();
  const [reorder, setReorder] = useState<unknown>(null);
  const [forecast, setForecast] = useState<unknown>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!ready || !isAuthenticated) return;
    setErr(null);
    Promise.all([
      apiJson("/analytics/reorder-recommendations"),
      apiJson("/analytics/forecast-summary"),
    ])
      .then(([r, f]) => {
        setReorder(r);
        setForecast(f);
      })
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
    <main className="pc-app-main" style={{ maxWidth: 900 }}>
      <PmsNav />
      <h1 style={{ marginTop: 0, color: "var(--pc-foreground)" }}>Analytics</h1>
      <p className="pc-muted" style={{ fontSize: "0.9rem" }}>
        Rule-based reorder suggestions and a lightweight sales window summary.
      </p>
      {err ? <Alert variant="error">{err}</Alert> : null}
      <h2 style={{ fontSize: "1.05rem", color: "var(--pc-foreground)" }}>Reorder recommendations</h2>
      <pre className="pc-panel">{reorder ? JSON.stringify(reorder, null, 2) : "…"}</pre>
      <h2 style={{ fontSize: "1.05rem", marginTop: "1.5rem", color: "var(--pc-foreground)" }}>Forecast summary</h2>
      <pre className="pc-panel">{forecast ? JSON.stringify(forecast, null, 2) : "…"}</pre>
    </main>
  );
}
