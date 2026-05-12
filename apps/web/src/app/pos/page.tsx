"use client";

import { FormEvent, useEffect, useState } from "react";
import { PmsNav } from "@/components/pms-nav";
import { apiJson } from "@/lib/auth-client";
import { useRequireAuth } from "@/lib/use-require-auth";

type BatchRow = {
  id: string;
  batchNo: string;
  product: { sku: string; name: string };
};

export default function PosPage() {
  const { ready, isAuthenticated } = useRequireAuth();
  const [batches, setBatches] = useState<BatchRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [invoice, setInvoice] = useState<unknown>(null);
  const [productId, setProductId] = useState("");
  const [batchId, setBatchId] = useState("");
  const [qty, setQty] = useState("1");
  const [unitPrice, setUnitPrice] = useState("0.00");

  useEffect(() => {
    if (!ready || !isAuthenticated) return;
    (async () => {
      try {
        setBatches(await apiJson<BatchRow[]>("/inventory/batches"));
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Could not load batches");
      }
    })();
  }, [ready, isAuthenticated]);

  async function checkout(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setInvoice(null);
    try {
      const sale = await apiJson("/sales/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [{ productId, batchId, qty: Number(qty), unitPrice }],
        }),
      });
      setInvoice(sale);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Checkout failed");
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
      <h1 style={{ marginTop: 0 }}>POS checkout</h1>
      <p style={{ color: "#555", fontSize: "0.9rem" }}>Requires branch with stock. Pick batch IDs from the list or paste UUIDs.</p>
      {err ? <p style={{ color: "#b91c1c" }}>{err}</p> : null}

      <section style={{ marginBottom: "1.5rem" }}>
        <h2 style={{ fontSize: "1.05rem" }}>Batches at branch</h2>
        <ul style={{ fontSize: "0.85rem", paddingLeft: "1.1rem", maxHeight: 180, overflow: "auto" }}>
          {batches.map((b) => (
            <li key={b.id} style={{ marginBottom: 4 }}>
              <code>{b.id.slice(0, 8)}…</code> {b.product.sku} / {b.batchNo}
            </li>
          ))}
        </ul>
      </section>

      <form onSubmit={checkout} style={{ display: "grid", gap: 8, maxWidth: 480 }}>
        <input placeholder="Product ID" value={productId} onChange={(e) => setProductId(e.target.value)} required style={{ padding: "0.35rem" }} />
        <input placeholder="Batch ID" value={batchId} onChange={(e) => setBatchId(e.target.value)} required style={{ padding: "0.35rem" }} />
        <div style={{ display: "flex", gap: 8 }}>
          <input placeholder="Qty" value={qty} onChange={(e) => setQty(e.target.value)} style={{ width: 80, padding: "0.35rem" }} />
          <input placeholder="Unit price" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} style={{ flex: 1, padding: "0.35rem" }} />
        </div>
        <button type="submit" style={{ padding: "0.45rem 1rem", width: "fit-content", cursor: "pointer" }}>
          Post sale
        </button>
      </form>

      {invoice ? (
        <pre
          style={{
            marginTop: "1.25rem",
            background: "#f4f4f5",
            padding: "0.75rem",
            borderRadius: 6,
            fontSize: "0.85rem",
            overflow: "auto",
          }}
        >
          {JSON.stringify(invoice, null, 2)}
        </pre>
      ) : null}
    </main>
  );
}
