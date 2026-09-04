"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert } from "@/components/alert";
import { IconAlertTriangle } from "@/components/icons";
import { Modal, ActionButton } from "@/components/ui";
import type { BulkExtras, BulkTarget } from "../hooks/use-product-bulk-actions";
import type {
  BulkProductAction,
  BulkProductPreview,
  ProductCategory,
  ProductTag,
} from "../types";
import css from "../products.module.css";

export type BulkOrganiseMode = "category" | "tags";

type Props = {
  mode: BulkOrganiseMode | null;
  target: BulkTarget | null;
  /** How many products the selection covers, for the title before the preview lands. */
  selectionCount: number;
  categories: ProductCategory[];
  tags: ProductTag[];
  running: boolean;
  onPreview: (
    action: BulkProductAction,
    target: BulkTarget,
    extras: BulkExtras,
  ) => Promise<BulkProductPreview | null>;
  onApply: (action: BulkProductAction, extras: BulkExtras) => void;
  onClose: () => void;
};

/**
 * Choose a category or tags for a bulk selection, and state what applying them would do
 * *before* it happens.
 *
 * The number that matters is not "217 products" — it is how many of those already carry a
 * category this would overwrite, and how many of those a person chose deliberately. Reporting
 * that afterwards is no use to anyone.
 */
export function BulkOrganiseModal({
  mode,
  target,
  selectionCount,
  categories,
  tags,
  running,
  onPreview,
  onApply,
  onClose,
}: Props) {
  const [categoryId, setCategoryId] = useState("");
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [tagMode, setTagMode] = useState<"add" | "remove">("add");
  const [preview, setPreview] = useState<BulkProductPreview | null>(null);
  const [checking, setChecking] = useState(false);

  const departments = useMemo(
    () => categories.filter((c) => !c.parentCategoryId),
    [categories],
  );
  const childrenByParent = useMemo(() => {
    const map = new Map<string, ProductCategory[]>();
    for (const c of categories) {
      if (!c.parentCategoryId) continue;
      const list = map.get(c.parentCategoryId) ?? [];
      list.push(c);
      map.set(c.parentCategoryId, list);
    }
    return map;
  }, [categories]);

  const action: BulkProductAction | null =
    mode === "category"
      ? categoryId === "__unclassified__"
        ? "clear_category"
        : "set_category"
      : mode === "tags"
        ? tagMode === "add"
          ? "add_tags"
          : "remove_tags"
        : null;

  const extras: BulkExtras = useMemo(
    () =>
      mode === "category"
        ? categoryId && categoryId !== "__unclassified__"
          ? { categoryId }
          : {}
        : { tagIds },
    [mode, categoryId, tagIds],
  );

  const ready =
    mode === "category" ? Boolean(categoryId) : tagIds.length > 0;

  // Reset whenever the modal opens for a different job.
  useEffect(() => {
    if (!mode) return;
    setCategoryId("");
    setTagIds([]);
    setTagMode("add");
    setPreview(null);
  }, [mode]);

  const refreshPreview = useCallback(async () => {
    if (!mode || !target || !action || !ready) {
      setPreview(null);
      return;
    }
    setChecking(true);
    setPreview(await onPreview(action, target, extras));
    setChecking(false);
  }, [mode, target, action, ready, extras, onPreview]);

  useEffect(() => {
    void refreshPreview();
  }, [refreshPreview]);

  function toggleTag(id: string) {
    setTagIds((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id],
    );
  }

  return (
    <Modal
      open={mode !== null}
      onClose={onClose}
      canDismiss={!running}
      title={mode === "category" ? "File under a category" : "Add or remove tags"}
      description={`${selectionCount.toLocaleString()} product${
        selectionCount === 1 ? "" : "s"
      } selected.`}
      footer={
        <>
          <ActionButton variant="secondary" onClick={onClose} disabled={running}>
            Cancel
          </ActionButton>
          <ActionButton
            onClick={() => action && onApply(action, extras)}
            disabled={
              !ready || running || checking || (preview !== null && preview.willChange === 0)
            }
          >
            {running ? "Applying…" : applyLabel(preview, mode, tagMode)}
          </ActionButton>
        </>
      }
    >
      {mode === "category" && (
        <label className={css.bulkField}>
          <span className={css.bulkFieldLabel}>Category</span>
          <select
            className={css.bulkSelect}
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
          >
            <option value="">Choose a category…</option>
            {departments.map((dept) => (
              <optgroup key={dept.id} label={dept.name}>
                <option value={dept.id}>{dept.name} (department)</option>
                {(childrenByParent.get(dept.id) ?? []).map((child) => (
                  <option key={child.id} value={child.id}>
                    {child.name}
                  </option>
                ))}
              </optgroup>
            ))}
            <optgroup label="Start over">
              <option value="__unclassified__">
                Move back to Unclassified, to be sorted again
              </option>
            </optgroup>
          </select>
        </label>
      )}

      {mode === "tags" && (
        <>
          <div className={css.bulkModeRow} role="radiogroup" aria-label="Tag action">
            {(["add", "remove"] as const).map((m) => (
              <label key={m} className={css.bulkModeOption}>
                <input
                  type="radio"
                  name="bulk-tag-mode"
                  checked={tagMode === m}
                  onChange={() => setTagMode(m)}
                />
                <span>{m === "add" ? "Add these tags" : "Remove these tags"}</span>
              </label>
            ))}
          </div>

          {tags.length === 0 ? (
            <p className={css.bulkEmpty}>
              No tags yet. Create one from Settings → Catalog → Tags first.
            </p>
          ) : (
            <div className={css.bulkTagList}>
              {tags.map((tag) => (
                <label key={tag.id} className={css.bulkTagOption}>
                  <input
                    type="checkbox"
                    checked={tagIds.includes(tag.id)}
                    onChange={() => toggleTag(tag.id)}
                  />
                  <span>{tag.name}</span>
                </label>
              ))}
            </div>
          )}
        </>
      )}

      <div className={css.bulkPreview} aria-live="polite">
        {!ready ? (
          <p className={css.bulkPreviewIdle}>
            {mode === "category"
              ? "Choose a category to see what this would change."
              : "Choose at least one tag to see what this would change."}
          </p>
        ) : checking || !preview ? (
          <p className={css.bulkPreviewIdle}>Checking…</p>
        ) : (
          <>
            <p className={css.bulkPreviewLead}>
              <strong>{preview.willChange.toLocaleString()}</strong> of{" "}
              {preview.matched.toLocaleString()} product
              {preview.matched === 1 ? "" : "s"} would change.
              {preview.alreadyOnTarget > 0 && (
                <>
                  {" "}
                  {preview.alreadyOnTarget.toLocaleString()}{" "}
                  {preview.alreadyOnTarget === 1 ? "is" : "are"} already{" "}
                  {mode === "category" ? "filed there" : "tagged"}.
                </>
              )}
            </p>

            {preview.replacingExisting > 0 && (
              <div className={css.bulkWarn}>
                <IconAlertTriangle size={15} />
                <span>
                  <strong>{preview.replacingExisting.toLocaleString()}</strong> already
                  {preview.replacingExisting === 1 ? " has" : " have"} a different category,
                  which this replaces
                  {preview.replacingManual > 0 && (
                    <>
                      {" "}
                      — <strong>{preview.replacingManual.toLocaleString()}</strong> of those
                      {preview.replacingManual === 1 ? " was" : " were"} chosen by hand
                    </>
                  )}
                  .
                </span>
              </div>
            )}

            {preview.willChange === 0 && (
              <Alert variant="info">
                Nothing to do — every selected product is already in that state.
              </Alert>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

function applyLabel(
  preview: BulkProductPreview | null,
  mode: BulkOrganiseMode | null,
  tagMode: "add" | "remove",
): string {
  const verb = mode === "category" ? "Apply to" : tagMode === "add" ? "Tag" : "Untag";
  if (!preview || preview.willChange === 0) {
    return mode === "category" ? "Apply" : verb;
  }
  return `${verb} ${preview.willChange.toLocaleString()} product${
    preview.willChange === 1 ? "" : "s"
  }`;
}
