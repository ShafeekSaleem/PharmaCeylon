"use client";

import { IconTag } from "@/components/icons";
import detailCss from "../product-detail.module.css";
import type { Product } from "../types";
import { formatDateTime } from "../utils/format";
import { FieldHint } from "./field-hint";
import { ProductAliasesEditor } from "./product-aliases-editor";

function Field({
  label,
  value,
}: {
  label: string;
  value: string | number | null | undefined;
}) {
  const display = value === null || value === undefined || value === "" ? "—" : String(value);
  return (
    <div className={detailCss.field}>
      <span className={detailCss.fieldLabel}>{label}</span>
      <span className={detailCss.fieldValue}>{display}</span>
    </div>
  );
}

type Props = {
  product: Product;
  canWrite: boolean;
  onAliasesChanged: () => void;
};

export function ProductDetailOverviewTab({
  product,
  canWrite,
  onAliasesChanged,
}: Props) {
  const categories = product.categories ?? [];
  const tags = product.tags ?? [];
  const aliases = product.aliases ?? [];

  return (
    <>
      <section className={detailCss.section}>
        <h2 className={detailCss.sectionTitle}>Basic information</h2>
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
        <h2 className={detailCss.sectionTitle}>Specifications</h2>
        <div className={detailCss.fieldGrid}>
          <Field label="Dosage form" value={product.dosageForm} />
          <Field label="Strength" value={product.strength} />
          <Field label="Unit" value={product.unit} />
          <Field label="Reorder level" value={product.reorderLevel} />
        </div>
      </section>

      <section className={detailCss.section}>
        <h2 className={detailCss.sectionTitle}>Catalog</h2>
        <div className={detailCss.taxonomyGrid}>
          <div className={detailCss.taxonomyCard}>
            <h3 className={detailCss.taxonomyCardTitle}>
              Categories <span className={detailCss.taxonomyCount}>({categories.length})</span>
            </h3>
            {categories.length === 0 ? (
              <p className={detailCss.muted}>No categories assigned.</p>
            ) : (
              <div className={detailCss.taxonomyChipList}>
                {categories.map((c) => (
                  <span key={c.id} className={`${detailCss.taxonomyChip} ${detailCss.taxonomyChipCategory}`}>
                    <IconTag size={12} />
                    {c.name}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className={detailCss.taxonomyCard}>
            <h3 className={detailCss.taxonomyCardTitle}>
              Tags <span className={detailCss.taxonomyCount}>({tags.length})</span>
            </h3>
            {tags.length === 0 ? (
              <p className={detailCss.muted}>No tags assigned.</p>
            ) : (
              <div className={detailCss.taxonomyChipList}>
                {tags.map((t) => (
                  <span key={t.id} className={`${detailCss.taxonomyChip} ${detailCss.taxonomyChipTag}`}>
                    <IconTag size={12} />
                    {t.name}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className={`${detailCss.taxonomyCard} ${detailCss.taxonomyCardWide}`}>
            <h3 className={detailCss.taxonomyCardTitle}>
              Search aliases <span className={detailCss.taxonomyCount}>({aliases.length})</span>
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
        <h2 className={detailCss.sectionTitle}>Record info</h2>
        <div className={detailCss.fieldGrid}>
          <Field label="Created" value={formatDateTime(product.createdAt)} />
          <Field label="Last updated" value={formatDateTime(product.updatedAt)} />
        </div>
      </section>
    </>
  );
}
