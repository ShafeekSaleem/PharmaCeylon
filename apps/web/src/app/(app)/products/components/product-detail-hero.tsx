"use client";

import { useRef, useState } from "react";
import {
  IconAlertTriangle,
  IconBox,
  IconDollarSign,
  IconEdit,
  IconPackage,
  IconTrash,
  IconX,
  IconZoomIn,
} from "@/components/icons";
import { StatusBadge } from "@/components/ui";
import { apiFetch, apiJson } from "@/lib/auth-client";
import { PRODUCT_PLACEHOLDER_SRC } from "@/lib/product-placeholder";
import { PRODUCT_IMAGE_MAX_BYTES, PRODUCT_IMAGE_TYPES } from "../constants";
import detailCss from "../product-detail.module.css";
import listCss from "../products.module.css";
import type { Product, ProductDetail } from "../types";
import { computeMarginPercent, formatCurrency } from "../utils/format";

type Props = {
  product: Product;
  detail: ProductDetail;
  canWrite: boolean;
  /** API restricts DELETE /products/:id to owner/manager; defaults to `canWrite` when omitted. */
  canDelete?: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onImageChanged: () => void;
};

export function ProductDetailHero({
  product,
  detail,
  canWrite,
  canDelete,
  onEdit,
  onDelete,
  onImageChanged,
}: Props) {
  const canDeleteProduct = canDelete ?? canWrite;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [imageZoomed, setImageZoomed] = useState(false);
  const [savingImage, setSavingImage] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);

  const summary = detail.branchSummary;
  const sellPrice =
    summary?.primarySellingPrice ?? detail.pricing.minSellingPrice;
  const costPrice = summary?.primaryCostPrice ?? detail.pricing.minCostPrice;
  const margin =
    summary?.marginPercent ??
    (sellPrice && costPrice ? computeMarginPercent(sellPrice, costPrice) : null);
  const activeBatches = detail.batches.filter((b) => b.qtyOnHand > 0).length;

  const uploadAndPatch = async (file: File) => {
    if (!PRODUCT_IMAGE_TYPES.includes(file.type)) {
      setImageError("Only JPEG, PNG, or WebP images are allowed.");
      return;
    }
    if (file.size > PRODUCT_IMAGE_MAX_BYTES) {
      setImageError("File must be under 2 MB.");
      return;
    }
    setImageError(null);
    setSavingImage(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const uploadRes = await apiFetch("/uploads/image?context=products", {
        method: "POST",
        body: formData,
      });
      if (!uploadRes.ok) {
        const body = await uploadRes.json().catch(() => null);
        throw new Error(body?.message || `Upload failed (${uploadRes.status})`);
      }
      const { url } = (await uploadRes.json()) as { url: string };
      await apiJson<Product>(`/products/${product.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrl: url }),
      });
      onImageChanged();
    } catch (err) {
      setImageError(err instanceof Error ? err.message : "Failed to update image.");
    } finally {
      setSavingImage(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <>
      <section className={detailCss.hero}>
        <div className={detailCss.heroTop}>
          <div className={detailCss.heroImageCol}>
            <div className={detailCss.heroImageFrame}>
              <img
                src={product.imageUrl ?? PRODUCT_PLACEHOLDER_SRC}
                alt={product.imageUrl ? product.name : ""}
                className={
                  product.imageUrl
                    ? detailCss.heroImage
                    : `${detailCss.heroImage} ${detailCss.heroImagePlaceholder}`
                }
              />
              {savingImage && <div className={detailCss.heroImageOverlay}>Uploading…</div>}
              {product.imageUrl && !savingImage && (
                <button
                  type="button"
                  className={detailCss.heroZoomBtn}
                  onClick={() => setImageZoomed(true)}
                  aria-label="View larger image"
                  data-tooltip="View larger image"
                >
                  <IconZoomIn size={14} />
                </button>
              )}
            </div>
            {canWrite && (
              <>
                <button
                  type="button"
                  className={detailCss.heroChangeImageBtn}
                  onClick={() => fileInputRef.current?.click()}
                  disabled={savingImage}
                >
                  <IconEdit size={14} />
                  Change image
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className={detailCss.heroImageFileInput}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void uploadAndPatch(file);
                  }}
                />
              </>
            )}
            {imageError && <p className={detailCss.error}>{imageError}</p>}
          </div>

          <div className={detailCss.heroMain}>
            <h1 className={detailCss.heroTitle}>{product.name}</h1>
            {product.genericName && (
              <p className={detailCss.heroGeneric}>{product.genericName}</p>
            )}
            <div className={detailCss.heroMeta}>
              <StatusBadge status={product.isActive ? "active" : "inactive"} dot />
              {product.isControlled && (
                <span className={listCss.controlledTag}>
                  <IconAlertTriangle size={11} />
                  Controlled
                </span>
              )}
            </div>
            <p className={detailCss.heroSku}>
              SKU {product.sku}
              {product.barcode ? ` · Barcode ${product.barcode}` : ""}
            </p>
          </div>

          {(canWrite || canDeleteProduct) && (
            <div className={detailCss.heroActions}>
              {canWrite && (
                <button type="button" className={detailCss.heroEditBtn} onClick={onEdit}>
                  <IconEdit size={16} />
                  Edit product
                </button>
              )}
              {canDeleteProduct && (
                <button type="button" className={detailCss.heroDeleteBtn} onClick={onDelete}>
                  <IconTrash size={16} />
                  Delete
                </button>
              )}
            </div>
          )}

          <div className={detailCss.heroMetrics}>
            <div className={detailCss.heroMetricTile}>
              <span className={detailCss.heroMetricLabel}>On-hand stock</span>
              <strong className={detailCss.heroMetricValue}>
                {detail.qtyOnHand != null ? `${detail.qtyOnHand} units` : "—"}
              </strong>
              <span className={`${detailCss.heroMetricIcon} ${detailCss.heroMetricIconPrimary}`}>
                <IconPackage size={15} />
              </span>
            </div>
            <div className={detailCss.heroMetricTile}>
              <span className={detailCss.heroMetricLabel}>Reorder level</span>
              <strong className={detailCss.heroMetricValue}>{product.reorderLevel} units</strong>
              <span className={`${detailCss.heroMetricIcon} ${detailCss.heroMetricIconInfo}`}>
                <IconBox size={15} />
              </span>
            </div>
            <div className={detailCss.heroMetricTile}>
              <span className={detailCss.heroMetricLabel}>Batches</span>
              <strong className={detailCss.heroMetricValue}>
                {activeBatches || detail.batches.length}
              </strong>
              <span className={detailCss.heroMetricSub}>
                {activeBatches > 0 ? "Active" : "None"}
              </span>
              <span className={`${detailCss.heroMetricIcon} ${detailCss.heroMetricIconSuccess}`}>
                <IconBox size={15} />
              </span>
            </div>
            <div className={detailCss.heroMetricTile}>
              <span className={detailCss.heroMetricLabel}>Sell price</span>
              <strong className={detailCss.heroMetricValue}>
                {sellPrice ? formatCurrency(sellPrice) : "—"}
              </strong>
              <span className={detailCss.heroMetricSub}>Per unit</span>
              <span className={`${detailCss.heroMetricIcon} ${detailCss.heroMetricIconPrimary}`}>
                <IconDollarSign size={15} />
              </span>
            </div>
            <div className={detailCss.heroMetricTile}>
              <span className={detailCss.heroMetricLabel}>Margin</span>
              <strong className={detailCss.heroMetricValue}>
                {margin != null ? `${margin}%` : "—"}
              </strong>
              <span className={`${detailCss.heroMetricIcon} ${detailCss.heroMetricIconSuccess}`}>
                <IconDollarSign size={15} />
              </span>
            </div>
          </div>
        </div>
      </section>

      {imageZoomed && product.imageUrl && (
        <div
          className={detailCss.imageZoomBackdrop}
          role="dialog"
          aria-modal="true"
          onClick={() => setImageZoomed(false)}
        >
          <button
            type="button"
            className={detailCss.imageZoomClose}
            onClick={() => setImageZoomed(false)}
            aria-label="Close"
            data-tooltip="Close"
          >
            <IconX size={18} />
          </button>
          <img
            src={product.imageUrl}
            alt={product.name}
            className={detailCss.imageZoomImg}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}
