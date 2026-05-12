"use client";

import { FormEvent, useEffect, useState } from "react";
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
      <h1 style={{ marginTop: 0 }}>Products</h1>
      {err ? <p style={{ color: "#b91c1c" }}>{err}</p> : null}

      <section style={{ marginBottom: "2rem" }}>
        <h2 style={{ fontSize: "1.05rem" }}>Add product</h2>
        <form onSubmit={onCreate} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
          <label>
            SKU
            <input value={sku} onChange={(e) => setSku(e.target.value)} required style={{ display: "block", marginTop: 4, padding: "0.35rem" }} />
          </label>
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} required style={{ display: "block", marginTop: 4, padding: "0.35rem", minWidth: 240 }} />
          </label>
          <button type="submit" style={{ padding: "0.4rem 0.9rem", cursor: "pointer" }}>
            Save
          </button>
        </form>
      </section>

      <section>
        <h2 style={{ fontSize: "1.05rem" }}>Catalog ({data?.total ?? "…"})</h2>
        <ul style={{ paddingLeft: "1.1rem" }}>
          {(data?.items ?? []).map((p) => (
            <li key={p.id} style={{ marginBottom: 6 }}>
              <code style={{ fontSize: "0.75rem", color: "#666" }}>{p.id}</code>
              <br />
              <strong>{p.sku}</strong> — {p.name}
              {p.brandName ? <span style={{ color: "#666" }}> ({p.brandName})</span> : null}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
