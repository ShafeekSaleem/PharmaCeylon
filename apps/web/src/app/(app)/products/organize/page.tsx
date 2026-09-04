"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Alert } from "@/components/alert";
import { IconCheck, IconGrid } from "@/components/icons";
import { ActionButton, PageHeader, SelectField, type SelectFieldOption } from "@/components/ui";
import { apiJson } from "@/lib/auth-client";
import { usePageChrome } from "@/lib/page-chrome-context";
import { usePermissions } from "@/lib/permissions";
import { CatalogTabs } from "../components/catalog-tabs";
import { useProductMeta } from "../hooks/use-product-meta";
import type { BulkProductResult } from "../types";
import css from "./organize.module.css";

const PAGE_SIZE = 50;

type Suggestion = {
  categoryId: string;
  categoryName: string;
  categoryPath: string;
  confidence: number;
};

type UnplacedProduct = {
  id: string;
  name: string;
  sku: string;
  brandName: string | null;
  genericName: string | null;
  dosageForm: string | null;
  strength: string | null;
  suggestion: Suggestion | null;
};

type Coverage = {
  ranged: number;
  categorized: number;
  unplaced: number;
  percent: number;
};

/**
 * The catalog-organisation worklist.
 *
 * A quarter of a real pharmacy's range sits in Unclassified with nothing surfacing it. This
 * page makes that a number that goes up and a list that runs out: products arrive grouped by
 * what they look like, so the job is confirming a suggestion for thirty items at once rather
 * than deciding one at a time.
 */
export default function OrganizeCatalogPage() {
  const { permissionKeys } = usePermissions();
  const canWrite = permissionKeys.includes("products.manage");
  const { setLastSegmentLabel } = usePageChrome();
  const { categories } = useProductMeta();

  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [items, setItems] = useState<UnplacedProduct[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Per-product override of the suggested category. */
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    setLastSegmentLabel("Organize");
    return () => setLastSegmentLabel(null);
  }, [setLastSegmentLabel]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [cov, page] = await Promise.all([
        apiJson<Coverage>("/products/organize/coverage"),
        apiJson<{ items: UnplacedProduct[]; total: number }>(
          `/products/organize/unplaced?take=${PAGE_SIZE}`,
        ),
      ]);
      setCoverage(cov);
      setItems(page.items);
      setTotal(page.total);
      setChosen({});
      setSelected(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load the worklist");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const departments = useMemo(
    () => categories.filter((c) => !c.parentCategoryId),
    [categories],
  );
  const childrenByParent = useMemo(() => {
    const map = new Map<string, typeof categories>();
    for (const c of categories) {
      if (!c.parentCategoryId) continue;
      const list = map.get(c.parentCategoryId) ?? [];
      list.push(c);
      map.set(c.parentCategoryId, list);
    }
    return map;
  }, [categories]);

  /** Departments then children, flattened for `SelectField` — it has no optgroup concept. */
  const categoryOptions = useMemo<SelectFieldOption[]>(() => {
    const options: SelectFieldOption[] = [];
    for (const dept of departments) {
      options.push({ value: dept.id, label: `${dept.name} (department)`, shortLabel: dept.name });
      for (const child of childrenByParent.get(dept.id) ?? []) {
        options.push({ value: child.id, label: `${dept.name} › ${child.name}`, shortLabel: child.name });
      }
    }
    return options;
  }, [departments, childrenByParent]);

  const rowCategoryOptions = useMemo<SelectFieldOption[]>(
    () => [{ value: "", label: "Choose a category…" }, ...categoryOptions],
    [categoryOptions],
  );
  const fileAllOptions = useMemo<SelectFieldOption[]>(
    () => [{ value: "", label: "File all selected under…" }, ...categoryOptions],
    [categoryOptions],
  );

  const categoryPath = useCallback(
    (categoryId: string): string => {
      const cat = categories.find((c) => c.id === categoryId);
      if (!cat) return "";
      const parent = cat.parentCategoryId
        ? categories.find((c) => c.id === cat.parentCategoryId)
        : null;
      return parent ? `${parent.name} › ${cat.name}` : cat.name;
    },
    [categories],
  );

  /** Grouped by where each product would land, so a whole group can be accepted at once. */
  const groups = useMemo(() => {
    const byTarget = new Map<
      string,
      { label: string; categoryId: string | null; products: UnplacedProduct[] }
    >();
    for (const item of items) {
      const categoryId = chosen[item.id] ?? item.suggestion?.categoryId ?? null;
      const key = categoryId ?? "__none__";
      const label = categoryId
        ? (item.suggestion?.categoryId === categoryId
            ? item.suggestion.categoryPath
            : categoryPath(categoryId))
        : "No suggestion — choose a category";
      const entry = byTarget.get(key) ?? { label, categoryId, products: [] };
      entry.products.push(item);
      byTarget.set(key, entry);
    }
    // Suggestion-less products first: they are the only ones that need a real decision.
    return [...byTarget.values()].sort((a, b) => {
      if (!a.categoryId !== !b.categoryId) return a.categoryId ? 1 : -1;
      return b.products.length - a.products.length;
    });
  }, [items, chosen, categoryPath]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleGroup(products: UnplacedProduct[], on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const p of products) {
        if (on) next.add(p.id);
        else next.delete(p.id);
      }
      return next;
    });
  }

  /** Apply one category to a set of products — the same bulk endpoint the Products page uses. */
  async function apply(productIds: string[], categoryId: string) {
    if (productIds.length === 0) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await apiJson<BulkProductResult>("/products/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set_category", productIds, categoryId }),
      });
      setNotice(
        `${result.updated.toLocaleString()} product${
          result.updated === 1 ? "" : "s"
        } filed.`,
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't file those products");
    } finally {
      setBusy(false);
    }
  }

  /** Accept every group whose products still carry their suggestion, in one pass. */
  async function acceptAllSuggestions() {
    const byCategory = new Map<string, string[]>();
    for (const item of items) {
      const categoryId = chosen[item.id] ?? item.suggestion?.categoryId;
      if (!categoryId) continue;
      byCategory.set(categoryId, [...(byCategory.get(categoryId) ?? []), item.id]);
    }
    if (byCategory.size === 0) return;

    setBusy(true);
    setError(null);
    setNotice(null);
    let filed = 0;
    try {
      for (const [categoryId, productIds] of byCategory) {
        const result = await apiJson<BulkProductResult>("/products/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "set_category", productIds, categoryId }),
        });
        filed += result.updated;
      }
      setNotice(`${filed.toLocaleString()} product${filed === 1 ? "" : "s"} filed.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't file those products");
    } finally {
      setBusy(false);
    }
  }

  const suggestedCount = items.filter(
    (i) => chosen[i.id] ?? i.suggestion?.categoryId,
  ).length;

  return (
    <div className={css.page}>
      <PageHeader
        subtitleOnly
        floatingActions
        description="Products you sell that aren't filed under a category yet."
        actions={
          canWrite && suggestedCount > 0 ? (
            <ActionButton
              icon={<IconCheck size={16} />}
              onClick={() => void acceptAllSuggestions()}
              disabled={busy}
            >
              Accept {suggestedCount.toLocaleString()} suggestion
              {suggestedCount === 1 ? "" : "s"}
            </ActionButton>
          ) : undefined
        }
      />

      <CatalogTabs active="organize" />

      {coverage && (
        <div className={css.coverage}>
          <div className={css.coverageBar}>
            <div
              className={css.coverageFill}
              style={{ width: `${coverage.percent}%` }}
              role="progressbar"
              aria-valuenow={coverage.percent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Catalog organised"
            />
          </div>
          <p className={css.coverageText}>
            <strong>{coverage.categorized.toLocaleString()}</strong> of{" "}
            {coverage.ranged.toLocaleString()} products filed —{" "}
            <strong>{coverage.percent}%</strong>
            {coverage.unplaced > 0 && (
              <>
                {" · "}
                {coverage.unplaced.toLocaleString()} to place
              </>
            )}
          </p>
        </div>
      )}

      {error && <Alert variant="error" onClose={() => setError(null)}>{error}</Alert>}
      {notice && <Alert variant="success" onClose={() => setNotice(null)}>{notice}</Alert>}

      {loading ? (
        <div className={css.card}>
          <p className={css.empty}>Loading…</p>
        </div>
      ) : items.length === 0 ? (
        <div className={css.card}>
          <p className={css.done}>
            <IconGrid size={18} />
            Everything you sell is filed under a category.
          </p>
          <p className={css.empty}>
            <Link href="/products/categories" className={css.link}>
              Review your categories
            </Link>{" "}
            or head back to <Link href="/products" className={css.link}>Products</Link>.
          </p>
        </div>
      ) : (
        <>
          {total > items.length && (
            <p className={css.pageNote}>
              Showing the first {items.length.toLocaleString()} of{" "}
              {total.toLocaleString()}. File these and the next batch loads.
            </p>
          )}

          {groups.map((group) => {
            const allSelected = group.products.every((p) => selected.has(p.id));
            return (
              <section key={group.categoryId ?? "none"} className={css.card}>
                <header className={css.groupHead}>
                  <label className={css.groupCheck}>
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={(e) => toggleGroup(group.products, e.target.checked)}
                      aria-label={`Select all in ${group.label}`}
                    />
                  </label>
                  <div className={css.groupTitleWrap}>
                    <h2 className={css.groupTitle}>{group.label}</h2>
                    <p className={css.groupCount}>
                      {group.products.length.toLocaleString()} product
                      {group.products.length === 1 ? "" : "s"}
                    </p>
                  </div>
                  {canWrite && group.categoryId && (
                    <ActionButton
                      variant="secondary"
                      disabled={busy}
                      onClick={() =>
                        void apply(
                          group.products.map((p) => p.id),
                          group.categoryId!,
                        )
                      }
                    >
                      File all {group.products.length.toLocaleString()}
                    </ActionButton>
                  )}
                </header>

                <ul className={css.rows}>
                  {group.products.map((product) => (
                    <li key={product.id} className={css.row}>
                      <label className={css.rowCheck}>
                        <input
                          type="checkbox"
                          checked={selected.has(product.id)}
                          onChange={() => toggle(product.id)}
                          aria-label={`Select ${product.name}`}
                        />
                      </label>
                      <div className={css.rowMain}>
                        <span className={css.rowName}>{product.name}</span>
                        <span className={css.rowMeta}>
                          {[
                            product.brandName,
                            product.genericName,
                            [product.dosageForm, product.strength]
                              .filter(Boolean)
                              .join(" · "),
                          ]
                            .filter(Boolean)
                            .join(" — ") || product.sku}
                        </span>
                      </div>
                      {canWrite && (
                        <SelectField
                          hideLabel
                          label={`Category for ${product.name}`}
                          className={css.rowSelectField}
                          fullWidth={false}
                          value={chosen[product.id] ?? product.suggestion?.categoryId ?? ""}
                          onChange={(value) =>
                            setChosen((prev) => ({ ...prev, [product.id]: value }))
                          }
                          options={rowCategoryOptions}
                          wideMenu
                        />
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </>
      )}

      {canWrite && selected.size > 0 && (
        <div className={css.selectionBar} role="region" aria-label="Selected products">
          <span className={css.selectionCount}>
            {selected.size.toLocaleString()} selected
          </span>
          <SelectField
            hideLabel
            label="File selected products under"
            className={css.rowSelectField}
            fullWidth={false}
            value=""
            onChange={(value) => {
              if (!value) return;
              void apply([...selected], value);
            }}
            options={fileAllOptions}
            wideMenu
          />
          <button
            type="button"
            className={css.clearSelection}
            onClick={() => setSelected(new Set())}
          >
            Clear selection
          </button>
        </div>
      )}
    </div>
  );
}
