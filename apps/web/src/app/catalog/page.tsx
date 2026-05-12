"use client";

import { FormEvent, useState } from "react";
import { PmsNav } from "@/components/pms-nav";
import { apiJson } from "@/lib/auth-client";
import { useRequireAuth } from "@/lib/use-require-auth";

export default function CatalogPage() {
  const { ready, isAuthenticated } = useRequireAuth();
  const [q, setQ] = useState("");
  const [out, setOut] = useState<unknown>(null);
  const [err, setErr] = useState<string | null>(null);

  async function search(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      const params = new URLSearchParams({ q });
      setOut(await apiJson(`/catalog/search?${params.toString()}`));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Search failed");
    }
  }

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
        maxWidth: 800,
        margin: "0 auto",
      }}
    >
      <PmsNav />
      <h1 style={{ marginTop: 0 }}>Catalog search</h1>
      <p style={{ color: "#555", fontSize: "0.9rem" }}>
        Optional branch header adds <code>qtyOnHand</code> to results.
      </p>
      <form onSubmit={search} style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="SKU, name, barcode…" style={{ flex: 1, padding: "0.4rem" }} />
        <button type="submit" style={{ padding: "0.4rem 0.9rem", cursor: "pointer" }}>
          Search
        </button>
      </form>
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
        {out ? JSON.stringify(out, null, 2) : "Submit a query."}
      </pre>
    </main>
  );
}
