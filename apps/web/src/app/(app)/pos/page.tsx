"use client";

import type { CSSProperties } from "react";
import { FormEvent, Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Alert } from "@/components/alert";
import { apiJson } from "@/lib/auth-client";
import type { BatchRow } from "@/app/(app)/inventory/types";

const posInput: CSSProperties = {
  padding: "0.45rem 0.6rem",
  border: "1px solid var(--pc-border)",
  borderRadius: "var(--pc-radius-sm)",
  background: "var(--pc-input-bg)",
  color: "var(--pc-foreground)",
  fontFamily: "inherit",
  width: "100%",
  boxSizing: "border-box",
};

const labelStyle: CSSProperties = {
  display: "block",
  fontSize: "0.8rem",
  fontWeight: 600,
  color: "var(--pc-muted-fg)",
  marginBottom: 4,
};

type ProductOption = {
  id: string;
  sku: string;
  name: string;
};

function isSellable(b: BatchRow): boolean {
  return !b.expired && !b.isQuarantined && b.qtyOnHand > 0;
}

function blockedReason(b: BatchRow): string | null {
  if (b.isQuarantined) return "Quarantined";
  if (b.expired) return "Expired";
  if (b.qtyOnHand <= 0) return "Out of stock";
  return null;
}

function formatExpiry(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function PosPageContent() {
  const searchParams = useSearchParams();
  const deepProductId = searchParams.get("productId");
  const [batches, setBatches] = useState<BatchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [invoice, setInvoice] = useState<unknown>(null);
  const [productQuery, setProductQuery] = useState("");
  const [productId, setProductId] = useState(deepProductId ?? "");
  const [batchId, setBatchId] = useState("");
  const [qty, setQty] = useState("1");
  const [unitPrice, setUnitPrice] = useState("0.00");

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        const rows = await apiJson<BatchRow[]>("/inventory/batches?includeZero=true");
        // FEFO sort (API already orders by expiry asc; keep stable)
        const sorted = [...rows].sort(
          (a, b) => new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime(),
        );
        setBatches(sorted);

        const seedId = deepProductId ?? "";
        if (seedId) {
          setProductId(seedId);
          const sellable = sorted
            .filter((b) => b.productId === seedId && isSellable(b))
            .sort(
              (a, b) =>
                new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime(),
            );
          const first = sellable[0];
          if (first) {
            setBatchId(first.id);
            setUnitPrice(first.sellingPrice);
            setProductQuery(first.product.name);
          }
        }
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Could not load batches");
      } finally {
        setLoading(false);
      }
    })();
  }, [deepProductId]);

  const productsWithSellable = useMemo(() => {
    const map = new Map<string, ProductOption>();
    for (const b of batches) {
      if (!isSellable(b)) continue;
      if (!map.has(b.productId)) {
        map.set(b.productId, {
          id: b.productId,
          sku: b.product.sku,
          name: b.product.name,
        });
      }
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [batches]);

  const filteredProducts = useMemo(() => {
    const q = productQuery.trim().toLowerCase();
    if (!q) return productsWithSellable;
    return productsWithSellable.filter(
      (p) => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q),
    );
  }, [productsWithSellable, productQuery]);

  const productBatches = useMemo(() => {
    if (!productId) return [];
    return batches.filter((b) => b.productId === productId);
  }, [batches, productId]);

  const selectedBatch = useMemo(
    () => productBatches.find((b) => b.id === batchId) ?? null,
    [productBatches, batchId],
  );

  function selectProduct(id: string) {
    setProductId(id);
    setBatchId("");
    setUnitPrice("0.00");
    const sellable = batches
      .filter((b) => b.productId === id && isSellable(b))
      .sort((a, b) => new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime());
    const first = sellable[0];
    if (first) {
      setBatchId(first.id);
      setUnitPrice(first.sellingPrice);
    }
  }

  function selectBatch(id: string) {
    setBatchId(id);
    const b = batches.find((x) => x.id === id);
    if (b && isSellable(b)) {
      setUnitPrice(b.sellingPrice);
    }
  }

  async function checkout(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setInvoice(null);
    if (!productId || !batchId) {
      setErr("Select a product and batch");
      return;
    }
    if (selectedBatch && !isSellable(selectedBatch)) {
      setErr(blockedReason(selectedBatch) ?? "Batch cannot be sold");
      return;
    }
    try {
      const sale = await apiJson("/sales/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [{ productId, batchId, qty: Number(qty), unitPrice }],
        }),
      });
      setInvoice(sale);
      // Refresh stock after sale
      const rows = await apiJson<BatchRow[]>("/inventory/batches?includeZero=true");
      setBatches(
        [...rows].sort(
          (a, b) => new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime(),
        ),
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Checkout failed");
    }
  }

  return (
    <div style={{ maxWidth: 720 }}>
      <h1 style={{ marginTop: 0, color: "var(--pc-foreground)" }}>POS checkout</h1>
      <p className="pc-muted" style={{ fontSize: "0.9rem", marginTop: 0 }}>
        FEFO picker — expired and quarantined batches cannot be sold. Near-expiry (&lt;30 days) is
        allowed with a warning.
      </p>
      {err ? <Alert variant="error">{err}</Alert> : null}

      <form
        onSubmit={checkout}
        className="pc-panel"
        style={{ display: "grid", gap: 14, padding: "1.1rem 1.25rem", marginTop: "1rem" }}
      >
        <div>
          <label style={labelStyle} htmlFor="pos-product-search">
            Product
          </label>
          <input
            id="pos-product-search"
            placeholder="Search by name or SKU…"
            value={productQuery}
            onChange={(e) => setProductQuery(e.target.value)}
            style={{ ...posInput, marginBottom: 8 }}
            disabled={loading}
          />
          <select
            aria-label="Select product"
            value={productId}
            onChange={(e) => selectProduct(e.target.value)}
            required
            style={posInput}
            disabled={loading}
          >
            <option value="">{loading ? "Loading…" : "Select product with sellable stock"}</option>
            {filteredProducts.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.sku})
              </option>
            ))}
          </select>
          {!loading && productsWithSellable.length === 0 ? (
            <p className="pc-muted" style={{ fontSize: "0.8rem", margin: "6px 0 0" }}>
              No sellable batches at this branch.
            </p>
          ) : null}
        </div>

        <div>
          <label style={labelStyle} htmlFor="pos-batch">
            Batch (FEFO order)
          </label>
          <select
            id="pos-batch"
            aria-label="Select batch"
            value={batchId}
            onChange={(e) => selectBatch(e.target.value)}
            required
            style={posInput}
            disabled={!productId}
          >
            <option value="">{productId ? "Select batch" : "Select a product first"}</option>
            {productBatches.map((b) => {
              const reason = blockedReason(b);
              const near = !reason && b.nearExpiry;
              const label = [
                b.batchNo,
                `exp ${formatExpiry(b.expiryDate)}`,
                `qty ${b.qtyOnHand}`,
                `LKR ${b.sellingPrice}`,
                reason ? `— ${reason}` : near ? "— near expiry" : null,
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <option key={b.id} value={b.id} disabled={!!reason}>
                  {label}
                </option>
              );
            })}
          </select>
        </div>

        {selectedBatch?.nearExpiry && isSellable(selectedBatch) ? (
          <Alert variant="warning">
            Near expiry: {formatExpiry(selectedBatch.expiryDate)} (
            {selectedBatch.daysToExpiry} day{selectedBatch.daysToExpiry === 1 ? "" : "s"} left). Sale
            is still allowed.
          </Alert>
        ) : null}

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <div style={{ width: 100 }}>
            <label style={labelStyle} htmlFor="pos-qty">
              Qty
            </label>
            <input
              id="pos-qty"
              type="number"
              min={1}
              max={selectedBatch?.qtyOnHand ?? undefined}
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              required
              style={posInput}
            />
          </div>
          <div style={{ flex: 1, minWidth: 140 }}>
            <label style={labelStyle} htmlFor="pos-price">
              Unit price
            </label>
            <input
              id="pos-price"
              value={unitPrice}
              onChange={(e) => setUnitPrice(e.target.value)}
              required
              style={posInput}
            />
          </div>
        </div>

        {selectedBatch && isSellable(selectedBatch) ? (
          <p className="pc-muted" style={{ fontSize: "0.8rem", margin: 0 }}>
            Available: {selectedBatch.qtyOnHand}
            {selectedBatch.product.unit ? ` ${selectedBatch.product.unit}` : ""} · Batch{" "}
            {selectedBatch.batchNo}
          </p>
        ) : null}

        <button
          type="submit"
          className="pc-btn-primary-sm"
          style={{ width: "fit-content" }}
          disabled={!productId || !batchId || loading}
        >
          Post sale
        </button>
      </form>

      {invoice ? (
        <pre className="pc-panel" style={{ marginTop: "1.25rem" }}>
          {JSON.stringify(invoice, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}

export default function PosPage() {
  return (
    <Suspense fallback={<div className="pc-muted">Loading POS…</div>}>
      <PosPageContent />
    </Suspense>
  );
}
