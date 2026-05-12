"use client";

import { FormEvent, useEffect, useState } from "react";
import { PmsNav } from "@/components/pms-nav";
import { apiJson } from "@/lib/auth-client";
import { useRequireAuth } from "@/lib/use-require-auth";

type Po = {
  id: string;
  poNumber: string;
  status: string;
  supplier: { code: string; name: string };
};

export default function PurchasingPage() {
  const { ready, isAuthenticated } = useRequireAuth();
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
    if (!ready || !isAuthenticated) return;
    void load();
  }, [ready, isAuthenticated]);

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
      <h1 style={{ marginTop: 0 }}>Purchasing</h1>
      <p style={{ color: "#555", fontSize: "0.9rem" }}>
        Select a branch on the Dashboard first (<code>x-branch-id</code>). Use Products and Suppliers pages to copy UUIDs.
      </p>
      {err ? <p style={{ color: "#b91c1c" }}>{err}</p> : null}

      <section style={{ marginBottom: "2rem" }}>
        <h2 style={{ fontSize: "1.05rem" }}>New purchase order</h2>
        <form onSubmit={createPo} style={{ display: "grid", gap: 8, maxWidth: 520 }}>
          <input
            placeholder="Supplier ID (UUID)"
            value={supplierId}
            onChange={(e) => setSupplierId(e.target.value)}
            required
            style={{ padding: "0.35rem" }}
          />
          <input
            placeholder="Product ID (UUID)"
            value={productId}
            onChange={(e) => setProductId(e.target.value)}
            required
            style={{ padding: "0.35rem" }}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <input
              placeholder="Qty"
              value={orderedQty}
              onChange={(e) => setOrderedQty(e.target.value)}
              style={{ padding: "0.35rem", width: 100 }}
            />
            <input
              placeholder="Unit cost"
              value={unitCost}
              onChange={(e) => setUnitCost(e.target.value)}
              style={{ padding: "0.35rem", flex: 1 }}
            />
          </div>
          <button type="submit" style={{ padding: "0.4rem 0.9rem", width: "fit-content", cursor: "pointer" }}>
            Create draft PO
          </button>
        </form>
      </section>

      <section>
        <h2 style={{ fontSize: "1.05rem" }}>Purchase orders</h2>
        <ul style={{ listStyle: "none", padding: 0 }}>
          {orders.map((o) => (
            <li
              key={o.id}
              style={{
                border: "1px solid #e4e4e7",
                borderRadius: 6,
                padding: "0.75rem",
                marginBottom: 8,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 12,
              }}
            >
              <div>
                <strong>{o.poNumber}</strong> — {o.status}
                <div style={{ fontSize: "0.85rem", color: "#666" }}>
                  {o.supplier.code} {o.supplier.name}
                </div>
              </div>
              {o.status === "draft" ? (
                <button type="button" onClick={() => issue(o.id)} style={{ cursor: "pointer" }}>
                  Issue
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
