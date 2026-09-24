"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "@/components/alert";
import { IconPlus, IconSearch, IconTrash } from "@/components/icons";
import { apiJson } from "@/lib/auth-client";
import { PurchasingSelect } from "../../purchasing/components/purchasing-select";
import { usePurchasingAccess } from "../../purchasing/hooks/use-purchasing-access";
import { useProductOptions, type SupplierPriceRow } from "../../purchasing/hooks/use-suppliers";
import { formatMoney } from "../../purchasing/utils";
import pcss from "../../purchasing/purchasing.module.css";
import scss from "../suppliers.module.css";

type Props = {
  supplierId: string;
  supplierName: string;
};

/**
 * What this supplier charges, per product.
 *
 * Purchase order lines start from here rather than from the last batch cost — which is whatever
 * some branch paid on some day, possibly to somebody else entirely. Receiving keeps the "last
 * paid" column up to date beside the agreed price, so a supplier whose prices are creeping is
 * visible instead of merely expensive.
 */
export function SupplierPriceList({ supplierId, supplierName }: Props) {
  const access = usePurchasingAccess();
  const products = useProductOptions();
  const [rows, setRows] = useState<SupplierPriceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const lastCostEdit = useRef<"pack" | "unit">("pack");
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ productId: "", unitsPerPack: "1", packCost: "", unitCost: "" });

  /**
   * Pack cost and unit cost are the same number seen from two ends, so typing either fills the
   * other — and changing the pack size re-derives from whichever the buyer typed last. Asking
   * someone to divide 1,320 by 24 in their head at a desk is how the wrong cost gets saved.
   */
  function priceFields(next: Partial<typeof form>, edited: "pack" | "unit" | "size") {
    setForm((prev) => {
      const merged = { ...prev, ...next };
      const per = Math.max(Number(merged.unitsPerPack) || 1, 1);
      const source = edited === "size" ? lastCostEdit.current : edited;
      if (source === "pack") {
        const pack = Number(merged.packCost);
        merged.unitCost =
          merged.packCost.trim() && Number.isFinite(pack)
            ? String(Number((pack / per).toFixed(4)))
            : "";
      } else if (source === "unit") {
        const unit = Number(merged.unitCost);
        merged.packCost =
          merged.unitCost.trim() && Number.isFinite(unit)
            ? String(Number((unit * per).toFixed(2)))
            : "";
      }
      return merged;
    });
    if (edited !== "size") lastCostEdit.current = edited;
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiJson<SupplierPriceRow[]>(`/suppliers/${supplierId}/prices`)
      .then((data) => {
        if (!cancelled) {
          setRows(data);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load prices");
          setRows([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [supplierId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (row) =>
        row.product.name.toLowerCase().includes(q) ||
        row.product.sku.toLowerCase().includes(q) ||
        (row.supplierSku ?? "").toLowerCase().includes(q),
    );
  }, [rows, search]);

  const takenProductIds = useMemo(() => new Set(rows.map((r) => r.product.id)), [rows]);
  const productOptions = useMemo(
    () =>
      products.rows
        .filter((p) => !takenProductIds.has(p.id))
        .map((p) => ({ value: p.id, label: p.name, meta: p.sku })),
    [products.rows, takenProductIds],
  );

  async function save() {
    if (!form.productId || (!form.unitCost.trim() && !form.packCost.trim())) return;
    setSaving(true);
    setError(null);
    try {
      const next = await apiJson<SupplierPriceRow[]>(`/suppliers/${supplierId}/prices`, {
        method: "PUT",
        body: JSON.stringify({
          productId: form.productId,
          unitsPerPack: Number(form.unitsPerPack) || 1,
          ...(form.packCost.trim() ? { packCost: form.packCost.trim() } : {}),
          ...(form.unitCost.trim() ? { unitCost: form.unitCost.trim() } : {}),
        }),
      });
      setRows(next);
      setForm({ productId: "", unitsPerPack: "1", packCost: "", unitCost: "" });
      setAdding(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save the price");
    } finally {
      setSaving(false);
    }
  }

  async function remove(productId: string) {
    setSaving(true);
    setError(null);
    try {
      setRows(
        await apiJson<SupplierPriceRow[]>(`/suppliers/${supplierId}/prices/${productId}`, {
          method: "DELETE",
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove the price");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={scss.detailSection}>
      <div className={scss.detailSectionHeader}>
        <div>
          <h3 className={scss.detailSectionTitle}>Price list</h3>
          <p className={pcss.muted}>
            What {supplierName} charges. Order lines start from these prices.
          </p>
        </div>
        {access.canManagePrices && !adding && (
          <button type="button" className={pcss.actionBtn} onClick={() => setAdding(true)}>
            <IconPlus size={14} />
            Add product
          </button>
        )}
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      {adding && (
        <div className={pcss.extrasRow}>
          <div className={pcss.field}>
            <label className={pcss.fieldLabel}>Product</label>
            <PurchasingSelect
              label="Product"
              hideLabel
              value={form.productId}
              options={productOptions}
              placeholder={products.loading ? "Loading…" : "Select product…"}
              searchPlaceholder="Search SKU or name…"
              onChange={(value) => {
                const product = products.rows.find((p) => p.id === value);
                priceFields(
                  {
                    productId: value,
                    ...(product?.unitsPerPack
                      ? { unitsPerPack: String(product.unitsPerPack) }
                      : {}),
                  },
                  "size",
                );
              }}
              disabled={saving}
              allowClear
            />
          </div>
          <div className={pcss.field}>
            <label className={pcss.fieldLabel} htmlFor="price-units-per-pack">
              Units per pack
            </label>
            <input
              id="price-units-per-pack"
              type="number"
              min={1}
              className={pcss.input}
              value={form.unitsPerPack}
              onChange={(e) => priceFields({ unitsPerPack: e.target.value }, "size")}
              disabled={saving}
            />
          </div>
          <div className={pcss.field}>
            <label className={pcss.fieldLabel} htmlFor="price-pack-cost">
              Cost per pack
            </label>
            <input
              id="price-pack-cost"
              type="number"
              min={0}
              step="0.01"
              className={pcss.input}
              placeholder="0.00"
              value={form.packCost}
              onChange={(e) => priceFields({ packCost: e.target.value }, "pack")}
              disabled={saving}
            />
            <span className={pcss.packHint}>
              {Number(form.unitsPerPack) > 1
                ? `Fills the unit cost, and follows it — ${form.unitsPerPack} units per pack.`
                : "Same as the unit cost while the pack is a single unit."}
            </span>
          </div>
          <div className={pcss.field}>
            <label className={pcss.fieldLabel} htmlFor="price-unit-cost">
              Cost per unit
            </label>
            <input
              id="price-unit-cost"
              type="number"
              min={0}
              step="0.01"
              className={pcss.input}
              placeholder="0.00"
              value={form.unitCost}
              onChange={(e) => priceFields({ unitCost: e.target.value }, "unit")}
              disabled={saving}
            />
          </div>
          <div className={pcss.field}>
            <button
              type="button"
              className={`${pcss.actionBtn} ${pcss.actionBtnPrimary}`}
              onClick={() => void save()}
              disabled={saving || !form.productId}
            >
              {saving ? "Saving…" : "Save price"}
            </button>
            <button
              type="button"
              className={pcss.actionBtn}
              onClick={() => setAdding(false)}
              disabled={saving}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {rows.length > 4 && (
        <div className={pcss.searchWrap}>
          <IconSearch size={15} className={pcss.searchIcon} />
          <input
            type="search"
            className={pcss.searchInput}
            placeholder="Search this price list…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      )}

      {loading ? (
        <p className={pcss.muted}>Loading prices…</p>
      ) : filtered.length === 0 ? (
        <p className={pcss.muted}>
          {rows.length === 0
            ? "No prices on file yet. Prices are also learned automatically the first time you receive a delivery."
            : "Nothing matches that search."}
        </p>
      ) : (
        <div className={pcss.tableScroll}>
          <table className={pcss.suggestTable}>
            <thead>
              <tr>
                <th scope="col">Product</th>
                <th scope="col">Pack</th>
                <th scope="col">Agreed cost</th>
                <th scope="col">Last paid</th>
                {access.canManagePrices && <th scope="col" aria-label="Actions" />}
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr key={row.id}>
                  <td>
                    <div className={pcss.cellStrong}>{row.product.name}</div>
                    <div className={pcss.muted}>
                      {row.product.sku}
                      {row.supplierSku ? ` · their code ${row.supplierSku}` : ""}
                    </div>
                  </td>
                  <td>
                    {row.unitsPerPack > 1 ? `${row.unitsPerPack} per pack` : "Single units"}
                    {row.packCost && row.unitsPerPack > 1 ? (
                      <div className={pcss.muted}>{formatMoney(row.packCost)} per pack</div>
                    ) : null}
                  </td>
                  <td>{formatMoney(row.unitCost)}</td>
                  <td>
                    {formatMoney(row.lastUnitCost)}
                    {row.priceDrift ? (
                      <div className={pcss.muted}>
                        {Number(row.priceDrift) > 0 ? "▲" : "▼"} {formatMoney(Math.abs(Number(row.priceDrift)))}{" "}
                        vs agreed
                      </div>
                    ) : null}
                  </td>
                  {access.canManagePrices && (
                    <td>
                      <button
                        type="button"
                        className={pcss.actionBtn}
                        onClick={() => void remove(row.product.id)}
                        disabled={saving}
                        aria-label={`Remove ${row.product.name} from the price list`}
                      >
                        <IconTrash size={13} />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
