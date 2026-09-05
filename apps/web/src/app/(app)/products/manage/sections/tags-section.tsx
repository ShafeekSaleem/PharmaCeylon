"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert } from "@/components/alert";
import {
  IconChevronRight,
  IconInfo,
  IconPlus,
  IconSearch,
  IconTag,
} from "@/components/icons";
import { ActionButton, RowMenu } from "@/components/ui";
import { usePermissions } from "@/lib/permissions";
import { ConfirmDialog } from "../../components/confirm-dialog";
import type { ProductTag } from "../../types";
import { createTag, deleteTag, fetchTags, updateTag } from "../../tags/api";
import {
  TagFormModal,
  type TagModalState,
} from "../../tags/components/tag-form-modal";
import css from "./tags.module.css";

/**
 * Tags the pharmacy creates and applies itself.
 *
 * Two things were wrong with the version this replaces. The regulatory attributes the NMRA
 * import derives — schedule, controlled, prescription required, registration valid — sat in the
 * same flat, editable-looking list, complete with a Delete button for a control that does not
 * exist: one click there used to drop thousands of assignments the importer owns and would only
 * partly rebuild. They are now read-only and collapsed, stated as what they are.
 *
 * And a tag was drawn as a full-width table row, which is a lot of furniture for a word and a
 * number. They are laid out as labels now, which is both what they are and roughly four times
 * as many per screen — the difference between seeing your existing tags and adding a fifth
 * near-duplicate of one.
 */
export function TagsSection() {
  const { permissionKeys } = usePermissions();
  const canWrite = permissionKeys.includes("product_meta.manage");
  const canDelete = permissionKeys.includes("product_meta.delete");

  const [tags, setTags] = useState<ProductTag[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const [tagModal, setTagModal] = useState<TagModalState | null>(null);
  const [tagSaving, setTagSaving] = useState(false);
  const [tagError, setTagError] = useState<string | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<ProductTag | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setTags(await fetchTags());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load tags");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tags;
    return tags.filter((t) => t.name.toLowerCase().includes(q));
  }, [tags, query]);

  const ownTags = useMemo(
    () => filtered.filter((t) => !t.isSystem),
    [filtered],
  );
  const systemTags = useMemo(
    () => filtered.filter((t) => t.isSystem),
    [filtered],
  );

  async function handleTagModalSubmit(name: string) {
    if (!tagModal) return;
    setTagSaving(true);
    setTagError(null);
    try {
      if (tagModal.mode === "rename") await updateTag(tagModal.tag.id, name);
      else await createTag(name);
      await load();
      setTagModal(null);
    } catch (err) {
      setTagError(
        err instanceof Error
          ? err.message
          : tagModal.mode === "rename"
            ? "Failed to rename tag"
            : "Failed to create tag",
      );
    } finally {
      setTagSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteTag(deleteTarget.id);
      setDeleteTarget(null);
      await load();
    } catch (err) {
      setDeleteError(
        err instanceof Error ? err.message : "Failed to delete tag",
      );
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className={css.section}>
      <div className={css.head}>
        <p className={css.hint}>
          Labels for cutting across categories — filters, POS and reports all
          read them.
        </p>
        {canWrite && (
          <ActionButton
            icon={<IconPlus size={16} />}
            variant="secondary"
            onClick={() => {
              setTagError(null);
              setTagModal({ mode: "create" });
            }}
          >
            New tag
          </ActionButton>
        )}
      </div>

      {error ? <Alert variant="error">{error}</Alert> : null}

      {(tags.length > 0 || query) && (
        <div className={css.toolbar}>
          <div className={css.searchWrap}>
            <IconSearch size={15} className={css.searchIcon} />
            <input
              className={css.searchInput}
              type="search"
              placeholder="Search tags…"
              aria-label="Search tags"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {!canWrite && (
            <span className={css.readOnlyNote}>You have read-only access.</span>
          )}
        </div>
      )}

      {loading ? (
        <div className={css.empty}>
          <p className={css.emptyText}>Loading…</p>
        </div>
      ) : ownTags.length === 0 ? (
        <div className={css.empty}>
          <IconTag size={22} aria-hidden />
          <p className={css.emptyTitle}>
            {query
              ? "No tags match that search."
              : "You haven't created any tags yet."}
          </p>
          <p className={css.emptyText}>
            {query
              ? "Try a different word, or check the regulatory attributes below."
              : "Tags cut across categories — “Fridge line”, “Fast moving”, “Ward supply”. Apply them in bulk from the Products list."}
          </p>
        </div>
      ) : (
        <ul className={css.grid}>
          {ownTags.map((tag) => {
            const used = tag.rangedCount ?? 0;
            return (
              <li key={tag.id} className={css.tag}>
                <span className={css.tagDot} aria-hidden />
                <div className={css.tagBody}>
                  <span className={css.tagName} title={tag.name}>
                    {tag.name}
                  </span>
                  <span
                    className={`${css.tagCount}${used === 0 ? ` ${css.tagUnused}` : ""}`}
                  >
                    {used === 0
                      ? "Not used yet"
                      : `${used.toLocaleString()} product${used === 1 ? "" : "s"}`}
                  </span>
                </div>
                {(canWrite || canDelete) && (
                  <div className={css.tagActions}>
                    <RowMenu
                      label={tag.name}
                      actions={[
                        ...(canWrite
                          ? [
                              {
                                label: "Rename",
                                onClick: () => {
                                  setTagError(null);
                                  setTagModal({ mode: "rename", tag });
                                },
                              },
                            ]
                          : []),
                        ...(canDelete
                          ? [
                              {
                                label: "Delete",
                                danger: true,
                                separated: canWrite,
                                onClick: () => {
                                  setDeleteError(null);
                                  setDeleteTarget(tag);
                                },
                                hint:
                                  used > 0
                                    ? `Removes it from ${used.toLocaleString()} product${used === 1 ? "" : "s"}`
                                    : undefined,
                              },
                            ]
                          : []),
                      ]}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {systemTags.length > 0 && (
        <details className={css.systemDisclosure}>
          <summary className={css.systemSummary}>
            <IconChevronRight
              size={14}
              className={css.systemChevron}
              aria-hidden
            />
            <IconInfo size={14} aria-hidden />
            Regulatory attributes from the NMRA register ({systemTags.length})
          </summary>
          <div className={css.systemBody}>
            <p className={css.systemNote}>
              Schedule, controlled status, prescription requirement and
              registration validity come from the register and are re-applied on
              every import, so they can&apos;t be renamed or deleted. Filter by
              them from Products, or open a product to see its registration.
            </p>
            <ul className={css.systemList}>
              {systemTags.map((tag) => (
                <li key={tag.id} className={css.systemAttr}>
                  {tag.name}
                  <span className={css.systemAttrCount}>
                    {(tag.rangedCount ?? 0).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </details>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete this tag?"
        confirmLabel="Delete"
        loading={deleting}
        onCancel={() => {
          if (!deleting) setDeleteTarget(null);
        }}
        onConfirm={() => void handleDelete()}
      >
        {deleteError ? <Alert variant="error">{deleteError}</Alert> : null}
        <p>
          Permanently delete <strong>{deleteTarget?.name}</strong>? Product
          assignments using this tag will be removed. This cannot be undone.
        </p>
      </ConfirmDialog>

      <TagFormModal
        state={tagModal}
        saving={tagSaving}
        error={tagError}
        onClose={() => setTagModal(null)}
        onSubmit={(name) => void handleTagModalSubmit(name)}
      />
    </div>
  );
}
