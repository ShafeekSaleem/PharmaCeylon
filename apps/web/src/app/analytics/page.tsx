"use client";

import { useEffect, useState } from "react";
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
      <h1 style={{ marginTop: 0 }}>Analytics</h1>
      <p style={{ color: "#555", fontSize: "0.9rem" }}>Rule-based reorder suggestions and a lightweight sales window summary.</p>
      {err ? <p style={{ color: "#b91c1c" }}>{err}</p> : null}
      <h2 style={{ fontSize: "1.05rem" }}>Reorder recommendations</h2>
      <pre style={{ background: "#f4f4f5", padding: "0.75rem", borderRadius: 6, fontSize: "0.85rem", overflow: "auto" }}>
        {reorder ? JSON.stringify(reorder, null, 2) : "…"}
      </pre>
      <h2 style={{ fontSize: "1.05rem", marginTop: "1.5rem" }}>Forecast summary</h2>
      <pre style={{ background: "#f4f4f5", padding: "0.75rem", borderRadius: 6, fontSize: "0.85rem", overflow: "auto" }}>
        {forecast ? JSON.stringify(forecast, null, 2) : "…"}
      </pre>
    </main>
  );
}
