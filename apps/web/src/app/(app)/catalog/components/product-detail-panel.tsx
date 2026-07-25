"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Alert } from "@/components/alert";
import {
  IconAlertTriangle,
  IconBarcodeScan,
  IconFileText,
  IconInfo,
  IconPackage,
  IconSearch,
  IconShoppingCart,
} from "@/components/icons";
import { apiJson } from "@/lib/auth-client";
import { useAuth } from "@/lib/use-auth";
import css from "../catalog.module.css";
import type {
  CatalogAlternative,
  CatalogProductDetail,
  CatalogSearchItem,
} from "../types";
import { formatLkr, reasonLabel, stockStatusLabel } from "../utils";

type Props = {
  productId: string | null;
  fallback?: CatalogSearchItem | null;
  onSelectProduct: (id: string) => void;
  onScanBarcode?: () => void;
  onBrowse?: () => void;
  onLowStock?: () => void;
  compact?: boolean;
  onClose?: () => void;
};

function canSeeCost(roles: string[]): boolean {
  return roles.some((r) =>
    ["owner", "manager", "inventory_clerk", "analyst", "pharmacist"].includes(r),
  );
}

export function ProductDetailPanel({
  productId,
  fallback,
  onSelectProduct,
  onScanBarcode,
  onBrowse,
  onLowStock,
  compact,
  onClose,
}: Props) {
  const { user } = useAuth();
  const showCost = canSeeCost(user?.roles ?? []);
  const [detail, setDetail] = useState<CatalogProductDetail | null>(null);
  const [alts, setAlts] = useState<CatalogAlternative[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!productId) {
      setDetail(null);
      setAlts([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const [d, a] = await Promise.all([
          apiJson<CatalogProductDetail>(`/catalog/products/${productId}`),
          apiJson<{ items: CatalogAlternative[] }>(
            `/catalog/products/${productId}/alternatives`,
          ),
        ]);
        if (cancelled) return;
        setDetail(d);
        setAlts(a.items ?? []);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load product");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [productId]);

  if (!productId) {
    return (
      <aside className={`${css.panel} ${css.panelTall} ${css.panelIdleShell}`}>
        <div className={css.panelIdleCard}>
          <div className={css.panelIdleArt} aria-hidden>
            <IconFileText size={20} />
          </div>
          <div className={css.panelIdleCopy}>
            <h3 className={css.panelIdleTitle}>No product selected</h3>
            <p className={css.panelIdleText}>
              Search and select a product to view details, pricing, stock, and
              availability.
            </p>
          </div>
        </div>

        <div id="catalog-search-tips" className={css.tipsBlock}>
          <h3 className={css.sectionTitle}>Search tips</h3>
          <ul className={css.tipsList}>
            <li>
              <IconBarcodeScan size={14} />
              <span>
                <strong>Scan barcode:</strong> arms Exact match and focuses search.
                USB scanners type the code then <kbd>Enter</kbd> — no camera needed.
              </span>
            </li>
            <li>
              <IconSearch size={14} />
              <span>
                Press <kbd>/</kbd> anytime to focus search
              </span>
            </li>
            <li>
              <IconShoppingCart size={14} />
              <span>
                <kbd>↑</kbd>
                <kbd>↓</kbd> move · <kbd>Enter</kbd> open product
              </span>
            </li>
            <li>
              <IconInfo size={14} />
              <span>Chips stack with Category / Brand / Form / Stock filters</span>
            </li>
          </ul>
        </div>

        <div>
          <h3 className={css.sectionTitle}>Quick actions</h3>
          <div className={css.quickActions}>
            <button type="button" className={css.quickAction} onClick={onScanBarcode}>
              <IconBarcodeScan size={16} />
              Scan barcode
            </button>
            <button type="button" className={css.quickAction} onClick={onBrowse}>
              <IconPackage size={16} />
              Browse products
            </button>
            <button type="button" className={css.quickAction} onClick={onLowStock}>
              <IconAlertTriangle size={16} />
              View low stock
            </button>
            <Link href="/products" className={css.quickAction}>
              <IconFileText size={16} />
              All products
            </Link>
          </div>
        </div>
      </aside>
    );
  }

  const view = detail ?? fallback;

  return (
    <aside
      className={`${css.panel} ${css.panelTall}`}
      aria-label={view ? `Product ${view.name}` : "Product details"}
    >
      {compact && onClose ? (
        <button type="button" className={css.clearBtn} onClick={onClose}>
          Close
        </button>
      ) : null}

      {error ? <Alert variant="error">{error}</Alert> : null}
      {loading && !view ? <div className={css.loading}>Loading…</div> : null}

      {view ? (
        <>
          <div className={css.panelHeader}>
            {view.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={view.imageUrl} alt="" className={css.panelThumb} />
            ) : (
              <div className={`${css.panelThumb} ${css.thumbPlaceholder}`}>
                {view.name.slice(0, 2).toUpperCase()}
              </div>
            )}
            <div>
              <h2 className={css.panelTitle}>{view.name}</h2>
              <p className={css.panelSub}>
                {view.genericName || "—"}
                {view.brandName ? ` · ${view.brandName}` : ""}
              </p>
              <p className={css.panelSub}>
                {view.sku}
                {view.barcode ? ` · ${view.barcode}` : ""}
              </p>
              <div className={css.badgeRow}>
                {"isActive" in view && view.isActive ? (
                  <span className={`${css.flag} ${css.flagActive}`}>Active</span>
                ) : (
                  <span className={css.flag}>Inactive</span>
                )}
                {view.isControlled ? (
                  <span className={`${css.flag} ${css.flagControlled}`}>Controlled</span>
                ) : null}
                {view.stockStatus ? (
                  <span
                    className={`${css.stockPill} ${
                      view.stockStatus === "out"
                        ? css.stockOut
                        : view.stockStatus === "low"
                          ? css.stockLow
                          : css.stockOk
                    }`}
                  >
                    {stockStatusLabel(view.stockStatus)}
                  </span>
                ) : null}
              </div>
            </div>
          </div>

          <div className={css.statsGrid}>
            <div className={css.stat}>
              <span className={css.statLabel}>Sell price</span>
              <span className={css.statValue}>{formatLkr(view.sellPrice)}</span>
            </div>
            {showCost ? (
              <div className={css.stat}>
                <span className={css.statLabel}>Cost</span>
                <span className={css.statValue}>
                  {formatLkr(detail?.costPrice ?? null)}
                </span>
              </div>
            ) : null}
            <div className={css.stat}>
              <span className={css.statLabel}>Sellable stock</span>
              <span className={css.statValue}>
                {view.qtyOnHand == null ? "—" : `${view.qtyOnHand} units`}
              </span>
            </div>
            <div className={css.stat}>
              <span className={css.statLabel}>Reorder level</span>
              <span className={css.statValue}>{view.reorderLevel}</span>
            </div>
          </div>

          {view.categories?.length || view.tags?.length ? (
            <div>
              <h3 className={css.sectionTitle}>Categories & tags</h3>
              <div className={css.tagRow}>
                {(view.categories ?? []).map((c) => (
                  <span key={c.id} className={css.flag}>
                    {c.name}
                  </span>
                ))}
                {(view.tags ?? []).map((t) => (
                  <span key={t.id} className={css.flag}>
                    #{t.name}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {detail?.branchAvailability?.length ? (
            <div>
              <h3 className={css.sectionTitle}>Branch availability</h3>
              <ul className={css.branchList}>
                {detail.branchAvailability.map((b) => (
                  <li
                    key={b.branchId}
                    className={`${css.branchItem}${b.isActiveBranch ? ` ${css.branchActive}` : ""}`}
                  >
                    <span>
                      {b.code}
                      {b.isActiveBranch ? " (current)" : ""}
                    </span>
                    <span
                      className={`${css.stockPill} ${
                        b.stockStatus === "out"
                          ? css.stockOut
                          : b.stockStatus === "low"
                            ? css.stockLow
                            : css.stockOk
                      }`}
                    >
                      {b.qtyOnHand}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {alts.length > 0 ? (
            <div>
              <h3 className={css.sectionTitle}>Related / alternatives</h3>
              <ul className={css.altList}>
                {alts.slice(0, 6).map((alt) => (
                  <li key={alt.product.id}>
                    <button
                      type="button"
                      className={css.altBtn}
                      onClick={() => onSelectProduct(alt.product.id)}
                    >
                      <div className={css.productName}>{alt.product.name}</div>
                      <div className={css.productSub}>
                        {reasonLabel(alt.reason)}
                        {alt.qtyOnHand != null ? ` · ${alt.qtyOnHand} units` : ""}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className={css.panelActions}>
            <Link
              href={`/products/${view.id}`}
              className={`${css.actionBtn} ${css.actionBtnPrimary}`}
            >
              View product
            </Link>
            <Link
              href={`/pos?productId=${encodeURIComponent(view.id)}`}
              className={css.actionBtn}
            >
              <IconShoppingCart size={15} />
              Add to POS
            </Link>
            <Link
              href={`/inventory?productId=${encodeURIComponent(view.id)}`}
              className={css.actionBtn}
            >
              Inventory details
            </Link>
            <Link
              href={`/purchasing?productId=${encodeURIComponent(view.id)}`}
              className={css.actionBtn}
            >
              Order / PO
            </Link>
          </div>
        </>
      ) : null}
    </aside>
  );
}
