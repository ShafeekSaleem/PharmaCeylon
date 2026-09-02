"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert } from "@/components/alert";
import { IconEdit, IconPlus, IconSearch, IconTrash } from "@/components/icons";
import { ActionButton, PageHeader } from "@/components/ui";
import { usePermissions } from "@/lib/permissions";
import { ConfirmDialog } from "../../../products/components/confirm-dialog";
import type { ProductTag } from "../../../products/types";
import { CatalogMetaTabs } from "../components/catalog-meta-tabs";
import { createTag, deleteTag, fetchTags, updateTag } from "./api";
import { TagFormModal, type TagModalState } from "./components/tag-form-modal";
import css from "../categories/categories.module.css";

export default function CatalogTagsPage() {
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

  async function handleTagModalSubmit(name: string) {
    if (!tagModal) return;
    setTagSaving(true);
    setTagError(null);
    try {
      if (tagModal.mode === "rename") {
        await updateTag(tagModal.tag.id, name);
      } else {
        await createTag(name);
      }
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
      setDeleteError(err instanceof Error ? err.message : "Failed to delete tag");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className={css.page}>
      <PageHeader
        title="Tags"
        description="Free-form labels used to filter and group products across the Products page, POS, and reports."
        actions={
          canWrite ? (
            <ActionButton
              icon={<IconPlus size={16} />}
              onClick={() => {
                setTagError(null);
                setTagModal({ mode: "create" });
              }}
            >
              New Tag
            </ActionButton>
          ) : undefined
        }
      />

      <CatalogMetaTabs active="tags" />

      {error ? <Alert variant="error">{error}</Alert> : null}

      <div className={css.toolbar}>
        <div className={css.searchWrap}>
          <IconSearch size={15} className={css.searchIcon} />
          <input
            className={css.searchInput}
            placeholder="Search tags…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {!canWrite ? <span className={css.count}>You have read-only access to tags.</span> : null}
      </div>

      <div className={css.treeCard}>
        {loading ? (
          <div className={css.treeEmpty}>Loading…</div>
        ) : filtered.length === 0 ? (
          <div className={css.treeEmpty}>{query ? "No tags match." : "No tags yet."}</div>
        ) : (
          filtered.map((tag) => (
            <div key={tag.id} className={css.row}>
              <span className={css.disclosureSpacer} />
              <span className={css.rowName}>
                <span className={css.rowNameText}>{tag.name}</span>
              </span>
              <div className={css.rowMeta}>
                <span className={css.count}>
                  {tag.productCount ?? 0} product{(tag.productCount ?? 0) === 1 ? "" : "s"}
                </span>
              </div>
              {(canWrite || canDelete) && (
                <div className={css.rowActions}>
                  {canWrite && (
                    <button
                      type="button"
                      className={css.iconBtn}
                      aria-label={`Rename ${tag.name}`}
                      data-tooltip="Rename"
                      onClick={() => {
                        setTagError(null);
                        setTagModal({ mode: "rename", tag });
                      }}
                    >
                      <IconEdit size={14} />
                    </button>
                  )}
                  {canDelete && (
                    <button
                      type="button"
                      className={`${css.iconBtn} ${css.iconBtnDanger}`}
                      aria-label={`Delete ${tag.name}`}
                      data-tooltip="Delete"
                      onClick={() => {
                        setDeleteError(null);
                        setDeleteTarget(tag);
                      }}
                    >
                      <IconTrash size={14} />
                    </button>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>

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
          Permanently delete <strong>{deleteTarget?.name}</strong>? Product assignments using this
          tag will be removed. This cannot be undone.
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
