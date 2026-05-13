"use client";

import { FormEvent, useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import { PmsNav } from "@/components/pms-nav";
import { apiJson } from "@/lib/auth-client";
import { useRequireAuth } from "@/lib/use-require-auth";

type Supplier = { id: string; code: string; name: string; leadTimeDays: number };

export default function SuppliersPage() {
  const { ready, isAuthenticated } = useRequireAuth();
  const [items, setItems] = useState<Supplier[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");

  async function load() {
    setErr(null);
    try {
      setItems(await apiJson<Supplier[]>("/suppliers"));
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
      await apiJson("/suppliers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, name }),
      });
      setCode("");
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
    <main className="pc-app-main" style={{ maxWidth: 720 }}>
      <PmsNav />
      <h1 style={{ marginTop: 0, color: "var(--pc-foreground)" }}>Suppliers</h1>
      {err ? <Alert variant="error">{err}</Alert> : null}

      <section style={{ marginBottom: "2rem" }}>
        <h2 style={{ fontSize: "1.05rem", color: "var(--pc-foreground)" }}>Add supplier</h2>
        <form onSubmit={onCreate} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
          <label style={{ color: "var(--pc-muted-fg)", fontSize: "0.9rem" }}>
            Code
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
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
                minWidth: 220,
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

      <ul style={{ paddingLeft: "1.1rem" }}>
        {items.map((s) => (
          <li key={s.id} style={{ marginBottom: 8 }}>
            <code style={{ fontSize: "0.75rem", color: "var(--pc-muted-fg)" }}>{s.id}</code>
            <br />
            <strong>{s.code}</strong> — {s.name}{" "}
            <span style={{ color: "var(--pc-muted-fg)", fontSize: "0.9rem" }}>(lead {s.leadTimeDays}d)</span>
          </li>
        ))}
      </ul>
    </main>
  );
}
