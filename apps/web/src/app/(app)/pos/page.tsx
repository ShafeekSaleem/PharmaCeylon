"use client";

import type { CSSProperties } from "react";
import { FormEvent, useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import { apiJson } from "@/lib/auth-client";

const posInput: CSSProperties = {
  padding: "0.45rem 0.6rem",
  border: "1px solid var(--pc-border)",
  borderRadius: "var(--pc-radius-sm)",
  background: "var(--pc-input-bg)",
  color: "var(--pc-foreground)",
  fontFamily: "inherit",
};

type BatchRow = {
  id: string;
  batchNo: string;
  product: { sku: string; name: string };
};

export default function PosPage() {
  const [batches, setBatches] = useState<BatchRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [invoice, setInvoice] = useState<unknown>(null);
  const [productId, setProductId] = useState("");
  const [batchId, setBatchId] = useState("");
  const [qty, setQty] = useState("1");
  const [unitPrice, setUnitPrice] = useState("0.00");

  useEffect(() => {
    (async () => {
      try {
        setBatches(await apiJson<BatchRow[]>("/inventory/batches"));
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Could not load batches");
      }
    })();
  }, []);

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

  return (
    <div style={{ maxWidth: 800 }}>
      <h1 style={{ marginTop: 0, color: "var(--pc-foreground)" }}>POS checkout</h1>
      <p className="pc-muted" style={{ fontSize: "0.9rem" }}>
        Requires branch with stock. Pick batch IDs from the list or paste UUIDs.
      </p>
      {err ? <Alert variant="error">{err}</Alert> : null}

      <section style={{ marginBottom: "1.5rem" }}>
        <h2 style={{ fontSize: "1.05rem", color: "var(--pc-foreground)" }}>Batches at branch</h2>
        <ul style={{ fontSize: "0.85rem", paddingLeft: "1.1rem", maxHeight: 180, overflow: "auto" }}>
          {batches.map((b) => (
            <li key={b.id} style={{ marginBottom: 4 }}>
              <code>{b.id.slice(0, 8)}…</code> {b.product.sku} / {b.batchNo}
            </li>
          ))}
        </ul>
      </section>

      <form onSubmit={checkout} style={{ display: "grid", gap: 8, maxWidth: 480 }}>
        <input
          placeholder="Product ID"
          value={productId}
          onChange={(e) => setProductId(e.target.value)}
          required
          style={posInput}
        />
        <input
          placeholder="Batch ID"
          value={batchId}
          onChange={(e) => setBatchId(e.target.value)}
          required
          style={posInput}
        />
        <div style={{ display: "flex", gap: 8 }}>
          <input
            placeholder="Qty"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            style={{ ...posInput, width: 80 }}
          />
          <input
            placeholder="Unit price"
            value={unitPrice}
            onChange={(e) => setUnitPrice(e.target.value)}
            style={{ ...posInput, flex: 1 }}
          />
        </div>
        <button type="submit" className="pc-btn-primary-sm" style={{ width: "fit-content" }}>
          Post sale
        </button>
      </form>

      {invoice ? <pre className="pc-panel" style={{ marginTop: "1.25rem" }}>{JSON.stringify(invoice, null, 2)}</pre> : null}
    </div>
  );
}
