"use client";

import { FormEvent, useState } from "react";
import { Alert } from "@/components/alert";
import { apiJson } from "@/lib/auth-client";

export default function CatalogPage() {
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

  return (
    <div style={{ maxWidth: 800 }}>
      <h1 style={{ marginTop: 0, color: "var(--pc-foreground)" }}>Catalog search</h1>
      <p className="pc-muted" style={{ fontSize: "0.9rem" }}>
        Optional branch header adds <code>qtyOnHand</code> to results.
      </p>
      <form onSubmit={search} style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="SKU, name, barcode…"
          style={{
            flex: 1,
            padding: "0.45rem 0.6rem",
            border: "1px solid var(--pc-border)",
            borderRadius: "var(--pc-radius-sm)",
            background: "var(--pc-input-bg)",
            color: "var(--pc-foreground)",
          }}
        />
        <button type="submit" className="pc-btn-primary-sm">
          Search
        </button>
      </form>
      {err ? <Alert variant="error">{err}</Alert> : null}
      <pre className="pc-panel">{out ? JSON.stringify(out, null, 2) : "Submit a query."}</pre>
    </div>
  );
}
