"use client";

import { Alert } from "@/components/alert";
import {
  FormField,
  ImageUpload,
  Modal,
  ModalButton,
  ModalFooter,
} from "@/components/ui";
import { useMemo } from "react";
import { IconPill, IconShoppingBag } from "@/components/icons";
import css from "../products.module.css";
import type { Product, ProductCategory, ProductForm, ProductTag } from "../types";
import {
  deriveProductKind,
  medicinesDepartment,
  retailDepartments,
  type ProductKind,
} from "../utils/product-kind";
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
  const kind: ProductKind = useMemo(
    () => deriveProductKind(form, categories),
    [form, categories],
  );
  const isMedicine = kind === "medicine";
  const departments = useMemo(() => retailDepartments(categories), [categories]);
  const medicinesDept = useMemo(() => medicinesDepartment(categories), [categories]);

  /**
   * Switching kind re-files the product, because the primary category *is* the answer to
   * "medicine or not". The compliance flags are cleared on the way to retail: leaving
   * `isControlled` set on a hidden field would keep blocking the sale of a shampoo with
   * nothing on screen to explain why.
   */
  function setKind(next: ProductKind) {
    if (next === kind) return;
    const rest = form.categoryIds.slice(1);
    if (next === "medicine") {
      onFieldChange(
        "categoryIds",
        medicinesDept ? [medicinesDept.id, ...rest.filter((id) => id !== medicinesDept.id)] : rest,
      );
      return;
    }
    onFieldChange("isControlled", false);
    onFieldChange("requiresPrescription", false);
    const firstDepartment = departments[0];
    onFieldChange(
      "categoryIds",
      firstDepartment
        ? [firstDepartment.id, ...rest.filter((id) => id !== firstDepartment.id)]
        : rest,
    );
  }

  function setDepartment(categoryId: string) {
    const rest = form.categoryIds.slice(1).filter((id) => id !== categoryId);
    onFieldChange("categoryIds", categoryId ? [categoryId, ...rest] : rest);
  }

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
          {canWrite && (
            <ModalButton variant="primary" onClick={onSave} loading={saving}>
              Save
            </ModalButton>
          )}
        </ModalFooter>
      }
    >
      {formError && (
        <Alert variant="error" className={css.modalAlert}>
          {formError}
        </Alert>
      )}

      <div className={css.kindSwitch} role="group" aria-label="What are you adding?">
        <span className={css.kindSwitchLabel}>What are you adding?</span>
        <div className={css.kindOptions}>
          <button
            type="button"
            className={`${css.kindOption}${isMedicine ? ` ${css.kindOptionActive}` : ""}`}
            aria-pressed={isMedicine}
            disabled={saving}
            onClick={() => setKind("medicine")}
          >
            <IconPill size={16} />
            Medicine
          </button>
          <button
            type="button"
            className={`${css.kindOption}${!isMedicine ? ` ${css.kindOptionActive}` : ""}`}
            aria-pressed={!isMedicine}
            disabled={saving || departments.length === 0}
            onClick={() => setKind("retail")}
            data-tooltip={
              departments.length === 0
                ? "Turn on a non-medicine department in Settings → Catalog → Categories first"
                : undefined
            }
          >
            <IconShoppingBag size={16} />
            Retail item
          </button>
        </div>
      </div>

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
          {!isMedicine && (
            <FormField
              label="Department"
              as="select"
              value={form.categoryIds[0] ?? ""}
              onChange={(e) => setDepartment(e.target.value)}
              disabled={saving}
            >
              <option value="">Choose a department…</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </FormField>
          )}
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
            placeholder="Scan or enter barcode"
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
          {isMedicine ? (
            <FormField
              label="Generic name"
              value={form.genericName}
              onChange={(e) => onFieldChange("genericName", (e.target as HTMLInputElement).value)}
              error={fieldErrors.genericName}
              disabled={saving}
              placeholder="e.g. Paracetamol"
            />
          ) : (
            <FormField
              label="Brand"
              value={form.brandName}
              onChange={(e) => onFieldChange("brandName", (e.target as HTMLInputElement).value)}
              disabled={saving}
              placeholder="e.g. Sunsilk"
            />
          )}
        </div>
      </div>

      <h3 className={css.sectionTitle}>Classification</h3>
      <div className={css.twoCol}>
        {isMedicine && (
          <FormField
            label="Brand"
            value={form.brandName}
            onChange={(e) => onFieldChange("brandName", (e.target as HTMLInputElement).value)}
            disabled={saving}
            placeholder="e.g. Panadol"
          />
        )}
        <FormField
          label="Manufacturer"
          value={form.manufacturer}
          onChange={(e) => onFieldChange("manufacturer", (e.target as HTMLInputElement).value)}
          disabled={saving}
          placeholder={isMedicine ? "e.g. GlaxoSmithKline" : "e.g. Unilever"}
        />
        {/* Dosage form and strength are questions about a medicine. Adding a shampoo should
            not ask them — that was the whole complaint about this form. */}
        {isMedicine && (
          <FormField
            label="Dosage form"
            value={form.dosageForm}
            onChange={(e) => onFieldChange("dosageForm", (e.target as HTMLInputElement).value)}
            error={fieldErrors.dosageForm}
            disabled={saving}
            placeholder="e.g. Tablet, Capsule"
          />
        )}
        {isMedicine && (
          <FormField
            label="Strength"
            value={form.strength}
            onChange={(e) => onFieldChange("strength", (e.target as HTMLInputElement).value)}
            error={fieldErrors.strength}
            disabled={saving}
            placeholder="e.g. 500mg"
          />
        )}
        <FormField
          label="Unit"
          value={form.unit}
          onChange={(e) => onFieldChange("unit", (e.target as HTMLInputElement).value)}
          error={fieldErrors.unit}
          disabled={saving}
          placeholder={isMedicine ? "e.g. strip, bottle" : "e.g. bottle, pack"}
        />
        <FormField
          label="Pack size"
          value={form.packSize}
          onChange={(e) => onFieldChange("packSize", (e.target as HTMLInputElement).value)}
          error={fieldErrors.packSize}
          disabled={saving}
          placeholder={isMedicine ? "e.g. 30 tablets" : "e.g. 180 ml"}
        />
        <FormField
          label="Units per buying pack"
          type="number"
          min={1}
          value={form.unitsPerPack}
          onChange={(e) => onFieldChange("unitsPerPack", (e.target as HTMLInputElement).value)}
          disabled={saving}
          placeholder="1"
          hint="How many sellable units come in one pack you order. Purchase orders and deliveries count in these."
        />
        <FormField
          label="Name for one pack"
          value={form.packLabel}
          onChange={(e) => onFieldChange("packLabel", (e.target as HTMLInputElement).value)}
          disabled={saving}
          placeholder="e.g. Box of 24"
        />
      </div>

      <h3 className={css.sectionTitle}>
        {isMedicine ? "Specifications & compliance" : "Specifications"}
      </h3>
      <div className={css.twoCol}>
        {isMedicine && (
          <FormField
            label="Pack type"
            value={form.packType}
            onChange={(e) => onFieldChange("packType", (e.target as HTMLInputElement).value)}
            disabled={saving}
            placeholder="e.g. Alu-Alu blister"
          />
        )}
        <FormField
          label="Shelf life"
          value={form.shelfLife}
          onChange={(e) => onFieldChange("shelfLife", (e.target as HTMLInputElement).value)}
          error={fieldErrors.shelfLife}
          disabled={saving}
          placeholder="e.g. 24 months"
        />
        <FormField
          label="Storage"
          value={form.storage}
          onChange={(e) => onFieldChange("storage", e.target.value)}
          error={fieldErrors.storage}
          disabled={saving}
          placeholder="e.g. Store below 25°C"
          as="textarea"
          rows={2}
        />
        <FormField
          label="Tax category"
          value={form.taxCategory}
          onChange={(e) => onFieldChange("taxCategory", (e.target as HTMLInputElement).value)}
          disabled={saving}
          placeholder="e.g. Standard rate"
        />
      </div>

      {/* Gated on kind rather than on `source`: a pharmacist adding a medicine by hand should
          still be able to record its registration, and `source` is no longer user-set. */}
      {isMedicine && (
        <>
      <h3 className={css.sectionTitle}>NMRA registration</h3>
      <div className={css.twoCol}>
        <FormField
          label="Registration no."
          value={form.registrationNo}
          onChange={(e) => onFieldChange("registrationNo", (e.target as HTMLInputElement).value)}
          disabled={saving}
          placeholder="e.g. M009669"
        />
        <FormField
          label="Registration date"
          type="date"
          value={form.registrationDate}
          onChange={(e) => onFieldChange("registrationDate", (e.target as HTMLInputElement).value)}
          disabled={saving}
        />
        <FormField
          label="Schedule"
          value={form.schedule}
          onChange={(e) => onFieldChange("schedule", (e.target as HTMLInputElement).value)}
          disabled={saving}
          placeholder="e.g. II B"
        />
        <FormField
          label="Registration type"
          value={form.regType}
          onChange={(e) => onFieldChange("regType", (e.target as HTMLInputElement).value)}
          disabled={saving}
          placeholder="e.g. Full"
        />
        <FormField
          label="Dossier no."
          value={form.dossierNo}
          onChange={(e) => onFieldChange("dossierNo", (e.target as HTMLInputElement).value)}
          disabled={saving}
        />
        <FormField
          label="Country of origin"
          value={form.countryOfOrigin}
          onChange={(e) => onFieldChange("countryOfOrigin", (e.target as HTMLInputElement).value)}
          disabled={saving}
        />
        <FormField
          label="Local agent"
          value={form.localAgent}
          onChange={(e) => onFieldChange("localAgent", (e.target as HTMLInputElement).value)}
          disabled={saving}
        />
      </div>
        </>
      )}

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

      <h3 className={css.sectionTitle}>Inventory</h3>
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

        {isMedicine && (
        <div className={css.formBox}>
          <div className={css.formBoxLabelRow}>
            <span className={css.formBoxLabel}>Requires prescription</span>
            <FieldHint text="Sale needs a linked Rx (antibiotics, etc.). Cashiers can complete once Rx is on file." />
          </div>
          <label className={css.toggleLabel}>
            <input
              type="checkbox"
              className={css.toggleInput}
              checked={form.requiresPrescription || form.isControlled}
              onChange={(e) => onFieldChange("requiresPrescription", e.target.checked)}
              disabled={saving || form.isControlled}
            />
            <span className={css.toggleTrack} aria-hidden>
              <span className={css.toggleThumb} />
            </span>
            <span className={css.toggleText}>
              {form.requiresPrescription || form.isControlled ? "Yes" : "No"}
            </span>
          </label>
        </div>
        )}

        {isMedicine && (
        <div className={css.formBox}>
          <div className={css.formBoxLabelRow}>
            <span className={css.formBoxLabel}>Controlled substance</span>
            <FieldHint text="Schedule / narcotic — needs pharmacist till PIN or elevated session, and always requires a prescription." />
          </div>
          <label className={css.toggleLabel}>
            <input
              type="checkbox"
              className={css.toggleInput}
              checked={form.isControlled}
              onChange={(e) => {
                const checked = e.target.checked;
                onFieldChange("isControlled", checked);
                if (checked) onFieldChange("requiresPrescription", true);
              }}
              disabled={saving}
            />
            <span className={css.toggleTrack} aria-hidden>
              <span className={css.toggleThumb} />
            </span>
            <span className={css.toggleText}>{form.isControlled ? "Yes" : "No"}</span>
          </label>
        </div>
        )}

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
