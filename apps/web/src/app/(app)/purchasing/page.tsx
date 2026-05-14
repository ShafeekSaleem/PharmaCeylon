"use client";

import type { CSSProperties } from "react";
import { FormEvent, useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import { apiJson } from "@/lib/auth-client";

const pchInput: CSSProperties = {
  padding: "0.45rem 0.6rem",
  border: "1px solid var(--pc-border)",
  borderRadius: "var(--pc-radius-sm)",
  background: "var(--pc-input-bg)",
  color: "var(--pc-foreground)",
  fontFamily: "inherit",
};

type Po = {
  id: string;
  poNumber: string;
  status: string;
  supplier: { code: string; name: string };
};

export default function PurchasingPage() {
  const [orders, setOrders] = useState<Po[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [supplierId, setSupplierId] = useState("");
  const [productId, setProductId] = useState("");
  const [orderedQty, setOrderedQty] = useState("10");
  const [unitCost, setUnitCost] = useState("100.00");

  async function load() {
    setErr(null);
    try {
      const res = await apiJson<Po[]>("/purchasing/purchase-orders");
      setOrders(res);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load POs (pick a branch on Dashboard)");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function createPo(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      await apiJson("/purchasing/purchase-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          supplierId,
          items: [{ productId, orderedQty: Number(orderedQty), unitCost }],
        }),
      });
      setSupplierId("");
      setProductId("");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Create failed");
    }
  }

  async function issue(id: string) {
    setErr(null);
    try {
      await apiJson(`/purchasing/purchase-orders/${id}/issue`, { method: "POST" });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Issue failed");
    }
  }

  return (
    <div style={{ maxWidth: 900 }}>
      <h1 style={{ marginTop: 0, color: "var(--pc-foreground)" }}>Purchasing</h1>
      <p className="pc-muted" style={{ fontSize: "0.9rem" }}>
        Select a branch on the Dashboard first (<code>x-branch-id</code>). Use Products and Suppliers pages to copy UUIDs.
      </p>
      {err ? <Alert variant="error">{err}</Alert> : null}

      <section style={{ marginBottom: "2rem" }}>
        <h2 style={{ fontSize: "1.05rem", color: "var(--pc-foreground)" }}>New purchase order</h2>
        <form onSubmit={createPo} style={{ display: "grid", gap: 8, maxWidth: 520 }}>
          <input
            placeholder="Supplier ID (UUID)"
            value={supplierId}
            onChange={(e) => setSupplierId(e.target.value)}
            required
            style={pchInput}
          />
          <input
            placeholder="Product ID (UUID)"
            value={productId}
            onChange={(e) => setProductId(e.target.value)}
            required
            style={pchInput}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <input
              placeholder="Qty"
              value={orderedQty}
              onChange={(e) => setOrderedQty(e.target.value)}
              style={{ ...pchInput, width: 100 }}
            />
            <input
              placeholder="Unit cost"
              value={unitCost}
              onChange={(e) => setUnitCost(e.target.value)}
              style={{ ...pchInput, flex: 1 }}
            />
          </div>
          <button type="submit" className="pc-btn-primary-sm" style={{ width: "fit-content" }}>
            Create draft PO
          </button>
        </form>
      </section>

      <section>
        <h2 style={{ fontSize: "1.05rem", color: "var(--pc-foreground)" }}>Purchase orders</h2>
        <ul style={{ listStyle: "none", padding: 0 }}>
          {orders.map((o) => (
            <li
              key={o.id}
              style={{
                border: "1px solid var(--pc-border)",
                borderRadius: "var(--pc-radius-sm)",
                padding: "0.75rem",
                marginBottom: 8,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 12,
                background: "var(--pc-background)",
              }}
            >
              <div>
                <strong>{o.poNumber}</strong> — {o.status}
                <div style={{ fontSize: "0.85rem", color: "var(--pc-muted-fg)" }}>
                  {o.supplier.code} {o.supplier.name}
                </div>
              </div>
              {o.status === "draft" ? (
                <button type="button" className="pc-btn-outline" onClick={() => issue(o.id)}>
                  Issue
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
