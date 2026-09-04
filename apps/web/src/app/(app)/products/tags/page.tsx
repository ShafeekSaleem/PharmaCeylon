"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert } from "@/components/alert";
import { IconEdit, IconPlus, IconSearch, IconTrash } from "@/components/icons";
import { ActionButton, PageHeader } from "@/components/ui";
import { usePermissions } from "@/lib/permissions";
import { usePageChrome } from "@/lib/page-chrome-context";
import { ConfirmDialog } from "../components/confirm-dialog";
import type { ProductTag } from "../types";
import { CatalogTabs } from "../components/catalog-tabs";
import { createTag, deleteTag, fetchTags, updateTag } from "./api";
import { TagFormModal, type TagModalState } from "./components/tag-form-modal";
import css from "../categories/categories.module.css";

export default function CatalogTagsPage() {
  const { permissionKeys } = usePermissions();
  const { setLastSegmentLabel } = usePageChrome();

  // Without this the breadcrumb reads the raw path segment, "tags".
  useEffect(() => {
    setLastSegmentLabel("Tags");
    return () => setLastSegmentLabel(null);
  }, [setLastSegmentLabel]);
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

  // The ten NMRA-derived tags are the importer's, and mixing them into one flat list is how a
  // delete on "NMRA registered" came to sit next to a delete on the shop's own label.
  const ownTags = useMemo(() => filtered.filter((t) => !t.isSystem), [filtered]);
  const systemTags = useMemo(() => filtered.filter((t) => t.isSystem), [filtered]);

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

  function renderTagRow(tag: ProductTag, editable: boolean) {
    const ranged = tag.rangedCount ?? 0;
    const reference = tag.referenceCount ?? 0;
    return (
      <div key={tag.id} className={css.row}>
        <span className={css.disclosureSpacer} />
        <span className={css.rowName}>
          <span className={css.rowNameText}>{tag.name}</span>
          {!editable && <span className={css.lockedChip}>Managed</span>}
        </span>
        <div className={css.rowMeta}>
          <span className={css.count}>
            {ranged.toLocaleString()} product{ranged === 1 ? "" : "s"}
            {reference > 0 && (
              <span className={css.countMuted}>
                {" · "}
                {reference.toLocaleString()} reference
              </span>
            )}
          </span>
        </div>
        {(!editable || !(canWrite || canDelete)) && <span className={css.rowActionsSpacer} />}
        {editable && (canWrite || canDelete) && (
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
    );
  }

  return (
    <div className={css.page}>
      <PageHeader
        subtitleOnly
        floatingActions
        description="Labels for cutting across categories — filters, POS and reports all read them."
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

      <CatalogTabs active="tags" />

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

      {loading ? (
        <div className={css.treeCard}>
          <div className={css.treeEmpty}>Loading…</div>
        </div>
      ) : filtered.length === 0 ? (
        <div className={css.treeCard}>
          <div className={css.treeEmpty}>{query ? "No tags match." : "No tags yet."}</div>
        </div>
      ) : (
        <>
          <div className={css.groupHead}>
            <h2 className={css.groupTitle}>Your tags</h2>
            <p className={css.groupNote}>Free-form labels you create and apply yourself.</p>
          </div>
          <div className={css.treeCard}>
            {ownTags.length === 0 ? (
              <div className={css.treeEmpty}>
                {query ? "None of your own tags match." : "You haven't created any tags yet."}
              </div>
            ) : (
              ownTags.map((tag) => renderTagRow(tag, true))
            )}
          </div>

          {systemTags.length > 0 && (
            <>
              <div className={css.groupHead}>
                <h2 className={css.groupTitle}>Managed from the NMRA register</h2>
                <p className={css.groupNote}>
                  Applied by the import and refreshed with it, so they can&apos;t be renamed or
                  deleted here.
                </p>
              </div>
              <div className={css.treeCard}>
                {systemTags.map((tag) => renderTagRow(tag, false))}
              </div>
            </>
          )}
        </>
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
