"use client";

import { FormEvent, useEffect, useState } from "react";
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
        maxWidth: 720,
        margin: "0 auto",
      }}
    >
      <PmsNav />
      <h1 style={{ marginTop: 0 }}>Suppliers</h1>
      {err ? <p style={{ color: "#b91c1c" }}>{err}</p> : null}

      <section style={{ marginBottom: "2rem" }}>
        <h2 style={{ fontSize: "1.05rem" }}>Add supplier</h2>
        <form onSubmit={onCreate} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
          <label>
            Code
            <input value={code} onChange={(e) => setCode(e.target.value)} required style={{ display: "block", marginTop: 4, padding: "0.35rem" }} />
          </label>
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} required style={{ display: "block", marginTop: 4, padding: "0.35rem", minWidth: 220 }} />
          </label>
          <button type="submit" style={{ padding: "0.4rem 0.9rem", cursor: "pointer" }}>
            Save
          </button>
        </form>
      </section>

      <ul style={{ paddingLeft: "1.1rem" }}>
        {items.map((s) => (
          <li key={s.id} style={{ marginBottom: 8 }}>
            <code style={{ fontSize: "0.75rem", color: "#666" }}>{s.id}</code>
            <br />
            <strong>{s.code}</strong> — {s.name}{" "}
            <span style={{ color: "#666", fontSize: "0.9rem" }}>(lead {s.leadTimeDays}d)</span>
          </li>
        ))}
      </ul>
    </main>
  );
}
