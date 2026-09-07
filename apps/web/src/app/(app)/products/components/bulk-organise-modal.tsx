"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert } from "@/components/alert";
import { IconAlertTriangle, IconCheck, IconPlus, IconX } from "@/components/icons";
import { ActionButton, CategoryPicker, Modal, ModalFooter } from "@/components/ui";
import { apiJson } from "@/lib/auth-client";
import type { BulkExtras, BulkTarget } from "../hooks/use-product-bulk-actions";
import type {
  BulkProductAction,
  BulkProductPreview,
  ProductCategory,
  ProductTag,
} from "../types";
import css from "../products.module.css";

export type BulkOrganiseMode = "category" | "tags";

/** Sentinel for "put these back on the Unclassified floor", which is a category change too. */
const UNCLASSIFIED = "__unclassified__";

/** What the selected products already carry, so the dialog only offers real changes. */
type SelectionFacets = {
  matched: number;
  tags: Array<{ tagId: string; productCount: number }>;
  categories: Array<{ categoryId: string; productCount: number }>;
};

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
 * Two things this dialog has to get right. First, the number that matters is not "217
 * products" — it is how many of those already carry a category this would overwrite, and how
 * many of those a person chose deliberately; reporting that afterwards is no use to anyone.
 * Second, an option that would change nothing should not look like an option: a tag every
 * selected product already carries, or the category they are all already filed under, is
 * shown as such and can't be picked, rather than being offered and then answered with
 * "0 products updated".
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
  const [facets, setFacets] = useState<SelectionFacets | null>(null);

  const action: BulkProductAction | null =
    mode === "category"
      ? categoryId === UNCLASSIFIED
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
        ? categoryId && categoryId !== UNCLASSIFIED
          ? { categoryId }
          : {}
        : { tagIds },
    [mode, categoryId, tagIds],
  );

  const ready = mode === "category" ? Boolean(categoryId) : tagIds.length > 0;

  // Reset whenever the modal opens for a different job.
  useEffect(() => {
    if (!mode) return;
    setCategoryId("");
    setTagIds([]);
    setTagMode("add");
    setPreview(null);
  }, [mode]);

  /*
   * What the selection already looks like. Fetched once per opening rather than per option:
   * the alternative is one preview request per tag just to decide how to draw its chip.
   */
  useEffect(() => {
    if (!mode || !target) {
      setFacets(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const body =
          target.kind === "ids"
            ? { productIds: target.productIds }
            : { filter: Object.fromEntries(target.params.entries()) };
        const result = await apiJson<SelectionFacets>("/products/bulk/selection", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!cancelled) setFacets(result);
      } catch {
        // Coverage notes are an improvement on the dialog, not a precondition for it — without
        // them every option is simply offered, which is how this worked before.
        if (!cancelled) setFacets(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `target` is rebuilt on every render of the page; the selection it describes is what
    // matters, and that only changes while the dialog is closed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const refreshPreview = useCallback(async () => {
    if (!mode || !target || !action || !ready) {
      setPreview(null);
      return;
    }
    setChecking(true);
    setPreview(await onPreview(action, target, extras));
    setChecking(false);
    // Same reasoning as above: `target` is a fresh object each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, action, ready, extras, onPreview]);

  useEffect(() => {
    void refreshPreview();
  }, [refreshPreview]);

  const total = facets?.matched ?? selectionCount;
  const tagCoverage = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of facets?.tags ?? []) map.set(row.tagId, row.productCount);
    return map;
  }, [facets]);
  const categoryCoverage = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of facets?.categories ?? [])
      map.set(row.categoryId, row.productCount);
    return map;
  }, [facets]);

  /** Categories every selected product is already filed under can't be a change. */
  const categoryDisabled = useMemo(() => {
    const out: Record<string, string> = {};
    if (!facets || total === 0) return out;
    for (const [id, count] of categoryCoverage) {
      if (count >= total) out[id] = "already filed here";
    }
    return out;
  }, [categoryCoverage, facets, total]);

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
        /* ModalFooter, like every other dialog in the app — it is what spaces the two
           buttons apart and right-aligns them. Passing them bare left Cancel and Apply
           touching, on the wrong side of the footer. */
        <ModalFooter>
          <ActionButton variant="secondary" onClick={onClose} disabled={running}>
            Cancel
          </ActionButton>
          <ActionButton
            onClick={() => action && onApply(action, extras)}
            disabled={
              !ready ||
              running ||
              checking ||
              (preview !== null && preview.willChange === 0)
            }
          >
            {running ? "Applying…" : applyLabel(preview, mode, tagMode)}
          </ActionButton>
        </ModalFooter>
      }
    >
      {mode === "category" && (
        <div className={css.bulkField}>
          <span className={css.bulkFieldLabel}>Category</span>
          <CategoryPicker
            label="Category for the selected products"
            categories={categories}
            value={categoryId}
            onChange={setCategoryId}
            disabledReasons={categoryDisabled}
            meta={(id) => {
              const count = categoryCoverage.get(id) ?? 0;
              return count > 0 ? `${count} of ${total} here` : null;
            }}
            extra={{
              value: UNCLASSIFIED,
              label: "Move back to Unclassified",
              hint: "to be sorted again",
            }}
          />
        </div>
      )}

      {mode === "tags" && (
        <>
          {/* Add and remove are one control with two states, not two radio buttons: which one
              you are in changes what every chip below means, so it needs to read as a mode. */}
          <div
            className={css.tagModeSwitch}
            role="radiogroup"
            aria-label="Tag action"
          >
            {(["add", "remove"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={tagMode === m}
                className={`${css.tagModeOption}${
                  tagMode === m ? ` ${css.tagModeOptionActive}` : ""
                }`}
                onClick={() => {
                  setTagMode(m);
                  setTagIds([]);
                }}
              >
                {m === "add" ? <IconPlus size={13} /> : <IconX size={13} />}
                {m === "add" ? "Add tags" : "Remove tags"}
              </button>
            ))}
          </div>

          {tags.length === 0 ? (
            <p className={css.bulkEmpty}>
              No tags yet. Create one from Catalog management → Tags first.
            </p>
          ) : (
            <>
              <ul className={css.tagPicker}>
                {tags.map((tag) => {
                  const on = tagCoverage.get(tag.id) ?? 0;
                  const chosen = tagIds.includes(tag.id);
                  // Adding a tag every product already has, or removing one none of them
                  // carries, is a no-op — say so on the chip instead of accepting the click.
                  const noop =
                    facets !== null &&
                    (tagMode === "add" ? on >= total && total > 0 : on === 0);
                  const coverage =
                    facets === null || on === 0
                      ? null
                      : on >= total
                        ? "on all"
                        : `on ${on}`;

                  return (
                    <li key={tag.id}>
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={chosen}
                        disabled={noop}
                        className={`${css.tagChip}${chosen ? ` ${css.tagChipOn}` : ""}${
                          tagMode === "remove" && chosen
                            ? ` ${css.tagChipRemoving}`
                            : ""
                        }`}
                        onClick={() => toggleTag(tag.id)}
                      >
                        <span className={css.tagChipIcon} aria-hidden>
                          {chosen ? (
                            <IconCheck size={12} />
                          ) : tagMode === "add" ? (
                            <IconPlus size={12} />
                          ) : (
                            <IconX size={12} />
                          )}
                        </span>
                        <span className={css.tagChipName}>{tag.name}</span>
                        {coverage && (
                          <span className={css.tagChipCount}>{coverage}</span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
              <p className={css.tagPickerHint}>
                {tagMode === "add"
                  ? "Greyed tags are already on every selected product."
                  : "Greyed tags aren't on any of the selected products."}
              </p>
            </>
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
