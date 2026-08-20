"use client";

import { IconEdit, IconTag } from "@/components/icons";
import detailCss from "../product-detail.module.css";
import type { Product } from "../types";
import { formatDate, formatDateTime } from "../utils/format";
import { FieldHint } from "./field-hint";
import { ProductAliasesEditor } from "./product-aliases-editor";

function Field({
  label,
  value,
  badge,
}: {
  label: string;
  value: string | number | null | undefined;
  badge?: "controlled" | "standard";
}) {
  const display = value === null || value === undefined || value === "" ? "—" : String(value);
  const isBadge = badge === "controlled" || badge === "standard";
  return (
    <div className={`${detailCss.field}${isBadge ? ` ${detailCss.fieldWithBadge}` : ""}`}>
      <span className={detailCss.fieldLabel}>{label}</span>
      {badge === "controlled" ? (
        <span
          className={`${detailCss.controlledFieldBadge}${
            display === "Yes" ? ` ${detailCss.controlledFieldBadgeYes}` : ""
          }`}
        >
          {display}
        </span>
      ) : badge === "standard" ? (
        <span className={detailCss.standardBadge}>{display}</span>
      ) : (
        <span className={detailCss.fieldValue}>{display}</span>
      )}
    </div>
  );
}

type Props = {
  product: Product;
  canWrite: boolean;
  onEditAssignments: () => void;
  onAliasesChanged: () => void;
};

export function ProductDetailOverviewTab({
  product,
  canWrite,
  onEditAssignments,
  onAliasesChanged,
}: Props) {
  const categories = product.categories ?? [];
  const tags = product.tags ?? [];
  const aliases = product.aliases ?? [];

  return (
    <>
      <section className={detailCss.section}>
        <h2 className={detailCss.sectionTitle}>
          <span className={detailCss.sectionNumber}>1</span>
          Basic information
        </h2>
        <div className={detailCss.fieldGrid}>
          <Field label="Product name" value={product.name} />
          <Field label="Generic name" value={product.genericName} />
          <Field label="SKU" value={product.sku} />
          <Field label="Barcode" value={product.barcode} />
          <Field label="Brand" value={product.brandName} />
          <Field label="Manufacturer" value={product.manufacturer} />
        </div>
      </section>

      <section className={detailCss.section}>
        <h2 className={detailCss.sectionTitle}>
          <span className={detailCss.sectionNumber}>2</span>
          Specifications &amp; compliance
        </h2>
        <div className={detailCss.fieldGrid}>
          <Field label="Dosage form" value={product.dosageForm} />
          <Field label="Strength" value={product.strength} />
          <Field label="Unit" value={product.unit} />
          <Field label="Pack size" value={product.packSize} />
          <Field label="Pack type" value={product.packType} />
          <Field label="Storage" value={product.storage} />
          <Field label="Shelf life" value={product.shelfLife} />
          <Field
            label="Requires prescription"
            value={product.requiresPrescription || product.isControlled ? "Yes" : "No"}
            badge="standard"
          />
          <Field
            label="Controlled substance"
            value={product.isControlled ? "Yes" : "No"}
            badge="controlled"
          />
          <Field
            label="Tax category"
            value={product.taxCategory ?? "—"}
            badge={product.taxCategory ? "standard" : undefined}
          />
        </div>
      </section>

      {product.source === "NMRA" && (
        <section className={detailCss.section}>
          <h2 className={detailCss.sectionTitle}>
            <span className={detailCss.sectionNumber}>3</span>
            NMRA registration
          </h2>
          <div className={detailCss.fieldGrid}>
            <Field label="Registration no." value={product.registrationNo} />
            <Field label="Registration date" value={formatDate(product.registrationDate)} />
            <Field
              label="Schedule"
              value={product.schedule}
              badge={product.schedule ? "standard" : undefined}
            />
            <Field label="Registration type" value={product.regType} />
            <Field label="Dossier no." value={product.dossierNo} />
            <Field label="Country of origin" value={product.countryOfOrigin} />
            <Field label="Local agent" value={product.localAgent} />
          </div>
        </section>
      )}

      <section className={detailCss.section}>
        <div className={detailCss.sectionHead}>
          <h2 className={detailCss.sectionTitle}>
            <span className={detailCss.sectionNumber}>4</span>
            Catalog organization
          </h2>
          {canWrite && (
            <button
              type="button"
              className={detailCss.sectionActionBtn}
              onClick={onEditAssignments}
            >
              <IconEdit size={14} />
              Edit product
            </button>
          )}
        </div>
        <div className={detailCss.taxonomyGrid}>
          <div className={detailCss.taxonomyCard}>
            <h3 className={detailCss.taxonomyCardTitle}>
              Commercial Category
              <span className={detailCss.taxonomyCount}>({categories.length})</span>
            </h3>
            {categories.length === 0 ? (
              <p className={detailCss.muted}>No commercial category assigned.</p>
            ) : (
              <div className={detailCss.taxonomyChipList}>
                {categories.map((c) => (
                  <span
                    key={c.id}
                    className={`${detailCss.taxonomyChip} ${detailCss.taxonomyChipCategory}`}
                  >
                    <IconTag size={12} />
                    {c.name}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className={detailCss.taxonomyCard}>
            <h3 className={detailCss.taxonomyCardTitle}>
              Tags
              <span className={detailCss.taxonomyCount}>({tags.length})</span>
            </h3>
            {tags.length === 0 ? (
              <p className={detailCss.muted}>No tags assigned.</p>
            ) : (
              <div className={detailCss.taxonomyChipList}>
                {tags.map((t) => (
                  <span
                    key={t.id}
                    className={`${detailCss.taxonomyChip} ${detailCss.taxonomyChipTag}`}
                  >
                    <IconTag size={12} />
                    {t.name}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className={detailCss.taxonomyCard}>
            <h3 className={detailCss.taxonomyCardTitle}>
              Search aliases
              <span className={detailCss.taxonomyCount}>({aliases.length})</span>
              <FieldHint text="Alternate names that improve search and catalog lookup." />
            </h3>
            <ProductAliasesEditor
              productId={product.id}
              aliases={aliases}
              canWrite={canWrite}
              onChanged={onAliasesChanged}
              variant="detail"
            />
          </div>
        </div>
      </section>

      <section className={detailCss.section}>
        <h2 className={detailCss.sectionTitle}>
          <span className={detailCss.sectionNumber}>5</span>
          Record info
        </h2>
        <div className={detailCss.recordGrid}>
          <Field label="Created on" value={formatDateTime(product.createdAt)} />
          <Field label="Last updated on" value={formatDateTime(product.updatedAt)} />
          <Field label="Product ID" value={product.id} />
        </div>
      </section>
    </>
  );
}
