"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert } from "@/components/alert";
import {
  IconChevronRight,
  IconEdit,
  IconInfo,
  IconPlus,
  IconSearch,
  IconTrash,
} from "@/components/icons";
import { ActionButton } from "@/components/ui";
import { usePermissions } from "@/lib/permissions";
import { ConfirmDialog } from "../../components/confirm-dialog";
import type { ProductTag } from "../../types";
import { createTag, deleteTag, fetchTags, updateTag } from "../../tags/api";
import { TagFormModal, type TagModalState } from "../../tags/components/tag-form-modal";
import css from "../../categories/categories.module.css";
import manageCss from "../manage.module.css";

/**
 * Tags the pharmacy creates and applies itself.
 *
 * The regulatory attributes the NMRA import derives — schedule, controlled, prescription
 * required, registration valid — used to sit in the same flat, editable-looking list. They are
 * not tags in any sense a user can act on: they are facts about a registration, re-applied on
 * every import refresh, and a Delete button beside one implied a control that did not exist.
 * They now live in a collapsed, read-only area below, stated as what they are.
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

  /** Only ever called for the pharmacy's own tags now; system attributes render above. */
  function renderTagRow(tag: ProductTag) {
    const ranged = tag.rangedCount ?? 0;
    return (
      <div key={tag.id} className={css.row}>
        <span className={css.disclosureSpacer} />
        <span className={css.rowName}>
          <span className={css.rowNameText}>{tag.name}</span>
        </span>
        <div className={css.rowMeta}>
          <span className={css.count}>
            {ranged.toLocaleString()} product{ranged === 1 ? "" : "s"}
          </span>
        </div>
        {!(canWrite || canDelete) && <span className={css.rowActionsSpacer} />}
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
    );
  }

  return (
    <div className={css.page}>
      <div className={manageCss.sectionHeader}>
        <p className={manageCss.sectionHint}>
          Labels for cutting across categories — filters, POS and reports all read them.
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
              ownTags.map((tag) => renderTagRow(tag))
            )}
          </div>

          {/*
            Read-only, collapsed, and no longer shaped like the list above. These are facts the
            register states about a registration, not labels anyone here chose — rendering them
            as tag rows with a Rename and a Delete offered a control that never existed and, on
            the one occasion someone used it, dropped thousands of assignments the importer
            owns and would only partly rebuild.
          */}
          {systemTags.length > 0 && (
            <details className={manageCss.systemDisclosure}>
              <summary className={manageCss.systemSummary}>
                <IconChevronRight size={14} className={manageCss.systemChevron} aria-hidden />
                <IconInfo size={14} aria-hidden />
                Regulatory attributes from the NMRA register ({systemTags.length})
              </summary>
              <div className={manageCss.systemBody}>
                <p className={manageCss.systemNote}>
                  Schedule, controlled status, prescription requirement and registration validity
                  come from the register and are re-applied on every import, so they can&apos;t be
                  renamed or deleted. Filter by them from Products, or open a product to see its
                  registration.
                </p>
                <ul className={manageCss.systemList}>
                  {systemTags.map((tag) => (
                    <li key={tag.id} className={manageCss.systemAttr}>
                      {tag.name}
                      <span className={manageCss.systemAttrCount}>
                        {(tag.rangedCount ?? 0).toLocaleString()}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </details>
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
