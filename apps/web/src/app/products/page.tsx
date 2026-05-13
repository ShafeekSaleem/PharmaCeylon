"use client";

import { FormEvent, useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import { PmsNav } from "@/components/pms-nav";
import { apiJson } from "@/lib/auth-client";
import { useRequireAuth } from "@/lib/use-require-auth";

type Product = {
  id: string;
  sku: string;
  name: string;
  brandName: string | null;
  isActive: boolean;
};

type ProductList = { items: Product[]; total: number };

export default function ProductsPage() {
  const { ready, isAuthenticated } = useRequireAuth();
  const [data, setData] = useState<ProductList | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sku, setSku] = useState("");
  const [name, setName] = useState("");

  async function load() {
    setErr(null);
    try {
      setData(await apiJson<ProductList>("/products"));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load");
    }
  }

  useEffect(() => {
    if (!ready || !isAuthenticated) return;
    void load();
  }, [ready, isAuthenticated]);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      await apiJson("/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sku, name }),
      });
      setSku("");
      setName("");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Create failed");
    }
  }

  if (!ready || !isAuthenticated) {
    return (
      <main className="pc-app-main">
        <p className="pc-muted">Loading…</p>
      </main>
    );
  }

  return (
    <main className="pc-app-main" style={{ maxWidth: 960 }}>
      <PmsNav />
      <h1 style={{ marginTop: 0, color: "var(--pc-foreground)" }}>Products</h1>
      {err ? <Alert variant="error">{err}</Alert> : null}

      <section style={{ marginBottom: "2rem" }}>
        <h2 style={{ fontSize: "1.05rem", color: "var(--pc-foreground)" }}>Add product</h2>
        <form onSubmit={onCreate} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
          <label style={{ color: "var(--pc-muted-fg)", fontSize: "0.9rem" }}>
            SKU
            <input
              value={sku}
              onChange={(e) => setSku(e.target.value)}
              required
              style={{
                display: "block",
                marginTop: 4,
                padding: "0.4rem 0.5rem",
                border: "1px solid var(--pc-border)",
                borderRadius: "var(--pc-radius-sm)",
                background: "var(--pc-input-bg)",
                color: "var(--pc-foreground)",
              }}
            />
          </label>
          <label style={{ color: "var(--pc-muted-fg)", fontSize: "0.9rem" }}>
            Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              style={{
                display: "block",
                marginTop: 4,
                padding: "0.4rem 0.5rem",
                minWidth: 240,
                border: "1px solid var(--pc-border)",
                borderRadius: "var(--pc-radius-sm)",
                background: "var(--pc-input-bg)",
                color: "var(--pc-foreground)",
              }}
            />
          </label>
          <button type="submit" className="pc-btn-primary-sm">
            Save
          </button>
        </form>
      </section>

      <section>
        <h2 style={{ fontSize: "1.05rem", color: "var(--pc-foreground)" }}>Catalog ({data?.total ?? "…"})</h2>
        <ul style={{ paddingLeft: "1.1rem" }}>
          {(data?.items ?? []).map((p) => (
            <li key={p.id} style={{ marginBottom: 6 }}>
              <code style={{ fontSize: "0.75rem", color: "var(--pc-muted-fg)" }}>{p.id}</code>
              <br />
              <strong>{p.sku}</strong> — {p.name}
              {p.brandName ? <span style={{ color: "var(--pc-muted-fg)" }}> ({p.brandName})</span> : null}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
