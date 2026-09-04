"use client";

import { useState } from "react";
import { unlinkNmraLink } from "../api/nmra-link";
import type { Product } from "../types";
import detailCss from "../product-detail.module.css";
import { ConfirmDialog } from "./confirm-dialog";
import css from "./product-nmra-link.module.css";
import { ProductNmraLinkModal } from "./product-nmra-link-modal";

type Props = {
  product: Product;
  canWrite: boolean;
  onChanged: () => void;
};

/**
 * The "link this product to the register" card. Only offered for a product that could
 * plausibly need it — the shop's own product, still ranged, not itself a register row —
 * closing F5: a plain "Panadol 500mg Tablet" never picks up a registration number or
 * schedule on its own, and there was no way to fix that after the fact.
 */
export function ProductNmraLinkCard({ product, canWrite, onChanged }: Props) {
  const [modalOpen, setModalOpen] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A register row itself, or a reference-catalog product, isn't something to link — it IS
  // the thing other products link to.
  if (product.source === "NMRA" || product.rangeStatus !== "RANGED") {
    return null;
  }

  async function handleUnlink() {
    setUnlinking(true);
    setError(null);
    try {
      await unlinkNmraLink(product.id);
      setConfirmUnlink(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't unlink this product");
    } finally {
      setUnlinking(false);
    }
  }

  return (
    <div className={detailCss.sideCard}>
      <h3 className={detailCss.sideCardTitle}>NMRA register</h3>
      {error && <p className={detailCss.sideEmptyText}>{error}</p>}
      {product.nmraReferenceId ? (
        <div className={css.notice}>
          <div className={css.linkedRow}>
            <span className={css.linkedMeta}>
              {product.registrationNo ? (
                <>
                  Linked · Reg. no. <strong>{product.registrationNo}</strong>
                  {product.schedule ? ` · Schedule ${product.schedule}` : ""}
                </>
              ) : (
                "Linked to a register entry"
              )}
            </span>
          </div>
          {canWrite && (
            <button
              type="button"
              className={css.unlinkAction}
              onClick={() => setConfirmUnlink(true)}
            >
              Unlink
            </button>
          )}
        </div>
      ) : (
        <div className={css.notice}>
          <p className={detailCss.sideEmptyText}>Not linked to the NMRA register.</p>
          {canWrite && (
            <button
              type="button"
              className={detailCss.footerLink}
              onClick={() => setModalOpen(true)}
            >
              Find a match
            </button>
          )}
        </div>
      )}

      <ProductNmraLinkModal
        open={modalOpen}
        productId={product.id}
        onClose={() => setModalOpen(false)}
        onLinked={() => {
          setModalOpen(false);
          onChanged();
        }}
      />

      <ConfirmDialog
        open={confirmUnlink}
        title="Unlink from the register?"
        confirmLabel="Unlink"
        loading={unlinking}
        onConfirm={() => void handleUnlink()}
        onCancel={() => setConfirmUnlink(false)}
      >
        This puts every field the link changed back — registration number, schedule, name and
        compliance flags included. The register entry itself is unaffected and can be linked
        again later.
      </ConfirmDialog>
    </div>
  );
}
