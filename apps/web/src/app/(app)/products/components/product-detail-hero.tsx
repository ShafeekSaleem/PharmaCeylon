"use client";

import { useRef, useState } from "react";
import {
  IconAlertTriangle,
  IconEdit,
  IconPlus,
  IconTrash,
  IconX,
  IconZoomIn,
} from "@/components/icons";
import { StatusBadge } from "@/components/ui";
import { apiFetch, apiJson } from "@/lib/auth-client";
import { PRODUCT_PLACEHOLDER_SRC } from "@/lib/product-placeholder";
import { PRODUCT_IMAGE_MAX_BYTES, PRODUCT_IMAGE_TYPES } from "../constants";
import listCss from "../products.module.css";
import detailCss from "../product-detail.module.css";
import type { Product, ProductDetail } from "../types";
import { ProductStockBadge } from "./product-stock-badge";
import { ConfirmDialog } from "./confirm-dialog";

type Props = {
  product: Product;
  detail: ProductDetail | null;
  canWrite: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onImageChanged: () => void;
};

export function ProductDetailHero({
  product,
  detail,
  canWrite,
  onEdit,
  onDelete,
  onImageChanged,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [imageZoomed, setImageZoomed] = useState(false);
  const [savingImage, setSavingImage] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const [confirmRemoveImage, setConfirmRemoveImage] = useState(false);

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

  const removeImage = async () => {
    setImageError(null);
    setSavingImage(true);
    try {
      await apiJson<Product>(`/products/${product.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrl: null }),
      });
      setConfirmRemoveImage(false);
      onImageChanged();
    } catch (err) {
      setImageError(err instanceof Error ? err.message : "Failed to remove image.");
    } finally {
      setSavingImage(false);
    }
  };

  return (
    <>
      <section className={detailCss.hero}>
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
            {canWrite && !savingImage && (
              <>
                <button
                  type="button"
                  className={detailCss.heroImageAddBtn}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <IconPlus size={16} />
                  {product.imageUrl ? "Change" : "Add image"}
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
          {canWrite && product.imageUrl && !savingImage && (
            <button
              type="button"
              className={detailCss.heroImageRemove}
              onClick={() => setConfirmRemoveImage(true)}
            >
              Remove image
            </button>
          )}
          {imageError && <p className={detailCss.error}>{imageError}</p>}
        </div>

        <div className={detailCss.heroMain}>
          <h1 className={detailCss.heroTitle}>{product.name}</h1>
          {product.genericName && <p className={detailCss.heroGeneric}>{product.genericName}</p>}
          <div className={detailCss.heroMeta}>
            <StatusBadge status={product.isActive ? "active" : "inactive"} dot />
            {product.isControlled && (
              <span className={listCss.controlledTag}>
                <IconAlertTriangle size={11} />
                Controlled
              </span>
            )}
            {detail && (
              <ProductStockBadge
                qtyOnHand={detail.qtyOnHand}
                stockStatus={detail.stockStatus}
                reorderGap={detail.reorderGap}
                reorderLevel={product.reorderLevel}
                variant="inline"
              />
            )}
          </div>
          <p className={detailCss.heroSku}>
            SKU {product.sku}
            {product.barcode ? ` · Barcode ${product.barcode}` : ""}
          </p>
        </div>

        {canWrite && (
          <div className={detailCss.heroActions}>
            <button
              type="button"
              className={`${listCss.actionIcon} ${listCss.actionIconEdit}`}
              aria-label={`Edit ${product.name}`}
              data-tooltip="Edit product"
              onClick={onEdit}
            >
              <IconEdit size={17} />
            </button>
            <button
              type="button"
              className={`${listCss.actionIcon} ${listCss.actionIconDelete}`}
              aria-label={`Delete ${product.name}`}
              data-tooltip="Delete product"
              onClick={onDelete}
            >
              <IconTrash size={17} />
            </button>
          </div>
        )}
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

      <ConfirmDialog
        open={confirmRemoveImage}
        title="Remove product image?"
        confirmLabel="Remove"
        loading={savingImage}
        onCancel={() => {
          if (!savingImage) setConfirmRemoveImage(false);
        }}
        onConfirm={() => void removeImage()}
      >
        <p>
          Remove the image for <strong>{product.name}</strong>?
        </p>
        <p className={listCss.confirmDialogHint}>
          You can upload a new image afterward. This cannot be undone from here.
        </p>
      </ConfirmDialog>
    </>
  );
}
