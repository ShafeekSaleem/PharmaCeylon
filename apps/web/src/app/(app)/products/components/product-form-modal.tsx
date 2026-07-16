"use client";

import { Alert } from "@/components/alert";
import {
  FormField,
  ImageUpload,
  Modal,
  ModalButton,
  ModalFooter,
} from "@/components/ui";
import css from "../products.module.css";
import type { Product, ProductCategory, ProductForm, ProductTag } from "../types";
import { FieldHint } from "./field-hint";
import { ProductAliasesEditor } from "./product-aliases-editor";
import { RelationMultiSelect } from "./relation-multi-select";

type ProductFormModalProps = {
  open: boolean;
  canWrite: boolean;
  editingProduct: Product | null;
  form: ProductForm;
  saving: boolean;
  formError: string | null;
  fieldErrors: Record<string, string>;
  categories: ProductCategory[];
  tags: ProductTag[];
  onClose: () => void;
  onSave: () => void;
  onFieldChange: <K extends keyof ProductForm>(key: K, value: ProductForm[K]) => void;
  onCreateCategory?: (name: string) => Promise<ProductCategory | null>;
  onCreateTag?: (name: string) => Promise<ProductTag | null>;
  onManageMeta?: () => void;
  onAliasesChanged?: () => void;
};

export function ProductFormModal({
  open,
  canWrite,
  editingProduct,
  form,
  saving,
  formError,
  fieldErrors,
  categories,
  tags,
  onClose,
  onSave,
  onFieldChange,
  onCreateCategory,
  onCreateTag,
  onManageMeta,
  onAliasesChanged,
}: ProductFormModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editingProduct ? "Edit Product" : "Add Product"}
      size="lg"
      footer={
        <ModalFooter>
          <ModalButton variant="secondary" onClick={onClose}>
            Cancel
          </ModalButton>
          <ModalButton variant="primary" onClick={onSave} loading={saving}>
            Save
          </ModalButton>
        </ModalFooter>
      }
    >
      {formError && (
        <Alert variant="error" className={css.modalAlert}>
          {formError}
        </Alert>
      )}

      <h3 className={css.sectionTitle}>Basic Info</h3>
      <div className={css.basicGrid}>
        <div className={css.imageCol}>
          <ImageUpload
            value={form.imageUrl}
            onChange={(url) => onFieldChange("imageUrl", url)}
            folder="products"
            disabled={saving}
          />
        </div>
        <div className={css.fieldsCol}>
          <FormField
            label="SKU"
            required
            value={form.sku}
            onChange={(e) => onFieldChange("sku", (e.target as HTMLInputElement).value)}
            error={fieldErrors.sku}
            disabled={!!editingProduct || saving}
            placeholder="e.g. PARA-500"
          />
          <FormField
            label="Barcode"
            value={form.barcode}
            onChange={(e) => onFieldChange("barcode", (e.target as HTMLInputElement).value)}
            disabled={saving}
            placeholder="Optional"
          />
          <FormField
            label="Name"
            required
            value={form.name}
            onChange={(e) => onFieldChange("name", (e.target as HTMLInputElement).value)}
            error={fieldErrors.name}
            disabled={saving}
            placeholder="Product name"
          />
          <FormField
            label="Generic Name"
            value={form.genericName}
            onChange={(e) => onFieldChange("genericName", (e.target as HTMLInputElement).value)}
            disabled={saving}
            placeholder="Optional"
          />
        </div>
      </div>

      <h3 className={css.sectionTitle}>Classification</h3>
      <div className={css.twoCol}>
        <FormField
          label="Brand"
          value={form.brandName}
          onChange={(e) => onFieldChange("brandName", (e.target as HTMLInputElement).value)}
          disabled={saving}
          placeholder="Brand name"
        />
        <FormField
          label="Manufacturer"
          value={form.manufacturer}
          onChange={(e) => onFieldChange("manufacturer", (e.target as HTMLInputElement).value)}
          disabled={saving}
          placeholder="Manufacturer"
        />
        <FormField
          label="Dosage Form"
          value={form.dosageForm}
          onChange={(e) => onFieldChange("dosageForm", (e.target as HTMLInputElement).value)}
          disabled={saving}
          placeholder="e.g. Tablet, Capsule"
        />
        <FormField
          label="Strength"
          value={form.strength}
          onChange={(e) => onFieldChange("strength", (e.target as HTMLInputElement).value)}
          disabled={saving}
          placeholder="e.g. 500mg"
        />
        <FormField
          label="Unit"
          value={form.unit}
          onChange={(e) => onFieldChange("unit", (e.target as HTMLInputElement).value)}
          disabled={saving}
          placeholder="e.g. Strip, Bottle"
        />
      </div>

      <div className={css.sectionHead}>
        <h3 className={css.sectionTitle}>Categories &amp; tags</h3>
        {onManageMeta && (
          <button type="button" className={css.sectionActionLink} onClick={onManageMeta}>
            Manage all
          </button>
        )}
      </div>
      <div className={css.relationRow}>
        <RelationMultiSelect
          label="Categories"
          options={categories}
          selected={form.categoryIds}
          onChange={(categoryIds) => onFieldChange("categoryIds", categoryIds)}
          disabled={saving}
          onCreateNew={onCreateCategory}
        />
        <RelationMultiSelect
          label="Tags"
          options={tags}
          selected={form.tagIds}
          onChange={(tagIds) => onFieldChange("tagIds", tagIds)}
          disabled={saving}
          onCreateNew={onCreateTag}
        />
      </div>

      {editingProduct && onAliasesChanged && (
        <>
          <h3 className={css.sectionTitle}>
            Search aliases
            <FieldHint text="Alternate names improve catalog and product search (e.g. brand names, abbreviations)." />
          </h3>
          <div className={css.formBox}>
            <ProductAliasesEditor
              productId={editingProduct.id}
              aliases={editingProduct.aliases ?? []}
              canWrite={canWrite}
              disabled={saving}
              onChanged={onAliasesChanged}
            />
          </div>
        </>
      )}

      <h3 className={css.sectionTitle}>Inventory &amp; compliance</h3>
      <div className={css.complianceGrid}>
        <div className={css.formBox}>
          <div className={css.formBoxLabelRow}>
            <label className={css.formBoxLabel} htmlFor="product-reorder-level">
              Reorder level
            </label>
            <FieldHint text="Notify when available stock falls below this amount." />
          </div>
          <div className={css.reorderControl}>
            <input
              id="product-reorder-level"
              type="number"
              min={0}
              inputMode="numeric"
              className={css.reorderControlInput}
              value={form.reorderLevel}
              onChange={(e) =>
                onFieldChange("reorderLevel", Math.max(0, parseInt(e.target.value) || 0))
              }
              disabled={saving}
            />
            <span className={css.reorderControlSuffix}>units</span>
          </div>
        </div>

        <div className={css.formBox}>
          <div className={css.formBoxLabelRow}>
            <span className={css.formBoxLabel}>Controlled substance</span>
            <FieldHint text="Requires extra handling and tracking rules." />
          </div>
          <label className={css.toggleLabel}>
            <input
              type="checkbox"
              className={css.toggleInput}
              checked={form.isControlled}
              onChange={(e) => onFieldChange("isControlled", e.target.checked)}
              disabled={saving}
            />
            <span className={css.toggleTrack} aria-hidden>
              <span className={css.toggleThumb} />
            </span>
            <span className={css.toggleText}>{form.isControlled ? "Yes" : "No"}</span>
          </label>
        </div>

        {editingProduct && (
          <div className={css.formBox}>
            <div className={css.formBoxLabelRow}>
              <span className={css.formBoxLabel}>Active</span>
              <FieldHint text="Inactive products stay in history but hide from day-to-day ops." />
            </div>
            <label className={css.toggleLabel}>
              <input
                type="checkbox"
                className={css.toggleInput}
                checked={form.isActive}
                onChange={(e) => onFieldChange("isActive", e.target.checked)}
                disabled={saving}
              />
              <span className={css.toggleTrack} aria-hidden>
                <span className={css.toggleThumb} />
              </span>
              <span className={css.toggleText}>{form.isActive ? "Yes" : "No"}</span>
            </label>
          </div>
        )}
      </div>
    </Modal>
  );
}
