"use client";

import { useMemo, useRef, useState } from "react";
import { Alert } from "@/components/alert";
import { IconEdit, IconPlus, IconSearch, IconTrash, IconX } from "@/components/icons";
import { Modal, ModalButton, ModalFooter } from "@/components/ui";
import { useProductMetaMutations } from "../hooks/use-product-meta-mutations";
import css from "../products.module.css";
import type { ProductCategory, ProductTag } from "../types";
import { ConfirmDialog } from "./confirm-dialog";
import { ParentCategorySelect } from "./parent-category-select";

type Tab = "categories" | "tags";

type ProductMetaManagerModalProps = {
  open: boolean;
  canWrite: boolean;
  /** API restricts category/tag DELETE to owner/manager; defaults to `canWrite` when omitted. */
  canDelete?: boolean;
  categories: ProductCategory[];
  tags: ProductTag[];
  onClose: () => void;
  onRefresh: () => void;
};

export function ProductMetaManagerModal({
  open,
  canWrite,
  canDelete,
  categories,
  tags,
  onClose,
  onRefresh,
}: ProductMetaManagerModalProps) {
  const canDeleteMeta = canDelete ?? canWrite;
  const [tab, setTab] = useState<Tab>("categories");
  const [query, setQuery] = useState("");
  const [promptOpen, setPromptOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newParentId, setNewParentId] = useState<string>("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editParentId, setEditParentId] = useState<string>("");
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const meta = useProductMetaMutations(onRefresh);

  const categoryById = useMemo(() => {
    const map = new Map<string, ProductCategory>();
    for (const c of categories) map.set(c.id, c);
    return map;
  }, [categories]);

  const sortedCategories = useMemo(() => {
    const childrenOf = (parentId: string | null) =>
      categories
        .filter((c) => (c.parentCategoryId ?? null) === parentId)
        .sort((a, b) => a.name.localeCompare(b.name));

    const out: Array<ProductCategory & { depth: number }> = [];
    const walk = (parentId: string | null, depth: number) => {
      for (const c of childrenOf(parentId)) {
        out.push({ ...c, depth });
        walk(c.id, depth + 1);
      }
    };
    walk(null, 0);
    // Orphans (parent missing from list)
    for (const c of categories) {
      if (!out.some((x) => x.id === c.id)) {
        out.push({ ...c, depth: 0 });
      }
    }
    return out;
  }, [categories]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (tab === "tags") {
      if (!q) return tags;
      return tags.filter((item) => item.name.toLowerCase().includes(q));
    }
    if (!q) return sortedCategories;
    return sortedCategories.filter((item) => {
      const parentName = item.parentCategoryId
        ? categoryById.get(item.parentCategoryId)?.name ?? ""
        : "";
      return (
        item.name.toLowerCase().includes(q) ||
        parentName.toLowerCase().includes(q)
      );
    });
  }, [categoryById, query, sortedCategories, tab, tags]);

  const singular = tab === "categories" ? "category" : "tag";

  const parentOptions = useMemo(() => {
    const blocked = new Set<string>();
    if (editingId) {
      const walk = (id: string) => {
        blocked.add(id);
        for (const c of categories) {
          if ((c.parentCategoryId ?? null) === id) walk(c.id);
        }
      };
      walk(editingId);
    }
    return [
      { value: "", label: "None (top-level)", depth: 0 },
      ...sortedCategories
        .filter((c) => !blocked.has(c.id))
        .map((c) => ({
          value: c.id,
          label: c.name,
          depth: c.depth,
        })),
    ];
  }, [categories, editingId, sortedCategories]);

  const startEdit = (item: ProductCategory | ProductTag) => {
    setEditingId(item.id);
    setEditName(item.name);
    setEditParentId(
      "parentCategoryId" in item && item.parentCategoryId ? item.parentCategoryId : "",
    );
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditName("");
    setEditParentId("");
  };

  const switchTab = (next: Tab) => {
    setTab(next);
    setQuery("");
    setPromptOpen(false);
    setNewName("");
    setNewParentId("");
    setDeleteTarget(null);
    cancelEdit();
  };

  const openPrompt = () => {
    setPromptOpen(true);
    setNewName("");
    setNewParentId("");
    requestAnimationFrame(() => nameInputRef.current?.focus());
  };

  const closePrompt = () => {
    if (meta.busy) return;
    setPromptOpen(false);
    setNewName("");
    setNewParentId("");
  };

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    const result =
      tab === "categories"
        ? await meta.createCategory(name, newParentId || null)
        : await meta.createTag(name);
    if (result) {
      setNewName("");
      setNewParentId("");
      setPromptOpen(false);
    }
  };

  const handleSaveEdit = async () => {
    if (!editingId || !editName.trim()) return;
    const ok =
      tab === "categories"
        ? await meta.updateCategory(editingId, editName, editParentId || null)
        : await meta.updateTag(editingId, editName);
    if (ok) cancelEdit();
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    if (tab === "categories") await meta.deleteCategory(deleteTarget.id);
    else await meta.deleteTag(deleteTarget.id);
    setDeleting(false);
    setDeleteTarget(null);
  };

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title="Categories & tags"
        size="md"
        footer={
          <ModalFooter>
            <ModalButton variant="secondary" onClick={onClose}>
              Done
            </ModalButton>
          </ModalFooter>
        }
      >
        <p className={css.metaManagerHint}>
          Search and manage catalog labels. Categories support a parent for hierarchy
          (e.g. Dosage form → Tablet). Assign them when creating or editing a product.
        </p>

        {meta.error && (
          <Alert variant="error" className={css.modalAlert}>
            {meta.error}
          </Alert>
        )}

        <div className={css.metaManagerTabs} role="tablist">
          <button
            type="button"
            role="tab"
            className={`${css.metaManagerTab} ${tab === "categories" ? css.metaManagerTabActive : ""}`}
            onClick={() => switchTab("categories")}
          >
            Categories ({categories.length})
          </button>
          <button
            type="button"
            role="tab"
            className={`${css.metaManagerTab} ${tab === "tags" ? css.metaManagerTabActive : ""}`}
            onClick={() => switchTab("tags")}
          >
            Tags ({tags.length})
          </button>
        </div>

        <div className={css.metaManagerToolbar}>
          <div className={css.metaManagerSearch}>
            <IconSearch size={16} className={css.metaManagerSearchIcon} />
            <input
              type="search"
              className={css.metaManagerSearchInput}
              placeholder={`Search ${tab}…`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {canWrite && (
            <button
              type="button"
              className={css.relationAddNewBtn}
              onClick={openPrompt}
              disabled={meta.busy}
            >
              <IconPlus size={14} />
              Add new
            </button>
          )}
        </div>

        {promptOpen && canWrite && (
          <div className={css.relationCreatePrompt}>
            <label className={css.relationCreateLabel} htmlFor={`meta-new-${singular}`}>
              New {singular} name
            </label>
            <div className={css.relationCreateRow}>
              <input
                id={`meta-new-${singular}`}
                ref={nameInputRef}
                type="text"
                className={css.relationCreateInput}
                placeholder={`Enter ${singular} name…`}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                disabled={meta.busy}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleCreate();
                  }
                  if (e.key === "Escape") closePrompt();
                }}
              />
              <button
                type="button"
                className={css.relationCreateConfirm}
                onClick={() => void handleCreate()}
                disabled={meta.busy || !newName.trim()}
              >
                Create
              </button>
              <button
                type="button"
                className={css.relationCreateCancel}
                onClick={closePrompt}
                disabled={meta.busy}
                aria-label="Cancel"
                data-tooltip="Cancel"
              >
                <IconX size={14} />
              </button>
            </div>
            {tab === "categories" && (
              <ParentCategorySelect
                label="Parent category"
                value={newParentId}
                options={parentOptions}
                onChange={setNewParentId}
                disabled={meta.busy}
              />
            )}
          </div>
        )}

        <ul className={css.metaManagerList}>
          {filtered.length === 0 ? (
            <li className={css.metaManagerEmpty}>
              {query ? "No matches." : `No ${tab} yet.`}
            </li>
          ) : (
            filtered.map((item) => {
              const depth = "depth" in item && typeof item.depth === "number" ? item.depth : 0;
              const parentId =
                tab === "categories" &&
                "parentCategoryId" in item &&
                typeof item.parentCategoryId === "string"
                  ? item.parentCategoryId
                  : null;
              const parentName = parentId ? categoryById.get(parentId)?.name : null;
              return (
                <li
                  key={item.id}
                  className={`${css.metaManagerItem} ${
                    editingId === item.id ? css.metaManagerItemEditing : ""
                  }`}
                >
                  {editingId === item.id ? (
                    <div className={css.metaManagerEditCol}>
                      <div className={css.metaManagerEditRow}>
                        <input
                          type="text"
                          className={css.metaManagerAddInput}
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          disabled={meta.busy}
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void handleSaveEdit();
                            if (e.key === "Escape") cancelEdit();
                          }}
                        />
                        <button
                          type="button"
                          className={css.metaManagerSaveBtn}
                          onClick={() => void handleSaveEdit()}
                          disabled={meta.busy || !editName.trim()}
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          className={css.metaManagerCancelBtn}
                          onClick={cancelEdit}
                          disabled={meta.busy}
                          aria-label="Cancel"
                          data-tooltip="Cancel"
                        >
                          <IconX size={14} />
                        </button>
                      </div>
                      {tab === "categories" && (
                        <ParentCategorySelect
                          label="Parent category"
                          value={editParentId}
                          options={parentOptions}
                          onChange={setEditParentId}
                          disabled={meta.busy}
                        />
                      )}
                    </div>
                  ) : (
                    <>
                      <div
                        className={css.metaManagerItemText}
                        style={
                          tab === "categories" && depth > 0
                            ? { paddingLeft: `${depth * 0.85}rem` }
                            : undefined
                        }
                      >
                        <span className={css.metaManagerItemName}>
                          {tab === "categories" && depth > 0 ? (
                            <span className={css.metaManagerTreeGuide} aria-hidden />
                          ) : null}
                          {item.name}
                        </span>
                        {parentName ? (
                          <span className={css.metaManagerItemSub}>under {parentName}</span>
                        ) : null}
                        {"productCount" in item && item.productCount != null && (
                          <span className={css.metaManagerItemCount}>
                            {item.productCount} product{item.productCount === 1 ? "" : "s"}
                          </span>
                        )}
                      </div>
                      {(canWrite || canDeleteMeta) && (
                        <div className={css.metaManagerItemActions}>
                          {canWrite && (
                            <button
                              type="button"
                              className={`${css.actionIcon} ${css.actionIconEdit}`}
                              onClick={() => startEdit(item)}
                              aria-label={`Edit ${item.name}`}
                              data-tooltip={`Edit ${singular}`}
                            >
                              <IconEdit size={15} />
                            </button>
                          )}
                          {canDeleteMeta && (
                            <button
                              type="button"
                              className={`${css.actionIcon} ${css.actionIconDelete}`}
                              onClick={() => setDeleteTarget({ id: item.id, name: item.name })}
                              aria-label={`Delete ${item.name}`}
                              data-tooltip={`Delete ${singular}`}
                            >
                              <IconTrash size={15} />
                            </button>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </li>
              );
            })
          )}
        </ul>
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        title={`Delete ${singular}?`}
        confirmLabel="Delete"
        loading={deleting}
        onCancel={() => {
          if (!deleting) setDeleteTarget(null);
        }}
        onConfirm={() => void handleConfirmDelete()}
      >
        <p>
          Permanently delete <strong>{deleteTarget?.name}</strong>?
        </p>
        <p className={css.confirmDialogHint}>
          Product assignments using this {singular} will be removed. This cannot be undone.
        </p>
      </ConfirmDialog>
    </>
  );
}
