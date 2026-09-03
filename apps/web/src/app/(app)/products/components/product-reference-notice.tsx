"use client";

import { useState } from "react";
import { IconArchive, IconPlus } from "@/components/icons";
import { apiJson } from "@/lib/auth-client";
import detailCss from "../product-detail.module.css";

type Props = {
  productId: string;
  productName: string;
  canWrite: boolean;
  onRanged: () => void;
};

/**
 * Shown on a product that is still a reference-catalog record: it exists so a pharmacist can
 * look it up on the NMRA register, but the shop doesn't sell it yet. Someone who arrives here
 * from Search Catalog needs the promotion within reach, not back on the list page.
 */
export function ProductReferenceNotice({
  productId,
  productName,
  canWrite,
  onRanged,
}: Props) {
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    setAdding(true);
    setError(null);
    try {
      await apiJson("/products/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "range", productIds: [productId] }),
      });
      onRanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add that product");
      setAdding(false);
    }
  };

  return (
    <div className={detailCss.referenceNotice} role="status">
      <span className={detailCss.referenceNoticeIcon}>
        <IconArchive size={16} />
      </span>
      <div className={detailCss.referenceNoticeBody}>
        <strong>Reference catalog record.</strong> {productName} is on the NMRA register but
        isn&apos;t one of your products yet, so it won&apos;t appear in stock, purchasing or
        the till.
        {error ? <div className={detailCss.referenceNoticeError}>{error}</div> : null}
      </div>
      {canWrite && (
        <button
          type="button"
          className={detailCss.referenceNoticeBtn}
          disabled={adding}
          onClick={() => void add()}
        >
          <IconPlus size={14} />
          {adding ? "Adding…" : "Add to my products"}
        </button>
      )}
    </div>
  );
}
