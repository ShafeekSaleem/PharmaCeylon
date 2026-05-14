"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import { apiJson } from "@/lib/auth-client";

export default function AnalyticsPage() {
  const [reorder, setReorder] = useState<unknown>(null);
  const [forecast, setForecast] = useState<unknown>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
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
  }, []);

  return (
    <div style={{ maxWidth: 900 }}>
      <h1 style={{ marginTop: 0, color: "var(--pc-foreground)" }}>Analytics</h1>
      <p className="pc-muted" style={{ fontSize: "0.9rem" }}>
        Rule-based reorder suggestions and a lightweight sales window summary.
      </p>
      {err ? <Alert variant="error">{err}</Alert> : null}
      <h2 style={{ fontSize: "1.05rem", color: "var(--pc-foreground)" }}>Reorder recommendations</h2>
      <pre className="pc-panel">{reorder ? JSON.stringify(reorder, null, 2) : "…"}</pre>
      <h2 style={{ fontSize: "1.05rem", marginTop: "1.5rem", color: "var(--pc-foreground)" }}>Forecast summary</h2>
      <pre className="pc-panel">{forecast ? JSON.stringify(forecast, null, 2) : "…"}</pre>
    </div>
  );
}
