"use client";

import { useMemo, useState } from "react";
import {
  IconChevronRight,
  IconEdit,
  IconMoreVertical,
  IconPlus,
  IconTrash,
} from "@/components/icons";
import type { CommercialCategoryNode } from "../types";
import css from "../categories.module.css";

type Props = {
  nodes: CommercialCategoryNode[];
  query: string;
  canWrite: boolean;
  canDelete: boolean;
  busyId: string | null;
  onToggleActive: (node: CommercialCategoryNode) => void;
  onRename: (node: CommercialCategoryNode, name: string) => void;
  onCreateChild: (parent: CommercialCategoryNode | null, name: string) => void;
  onDelete: (node: CommercialCategoryNode) => void;
  onMove: (node: CommercialCategoryNode, direction: "up" | "down", siblings: CommercialCategoryNode[]) => void;
  onMoveProducts: (node: CommercialCategoryNode) => void;
};

/** Flattens (department -> children) into a search-matched, always-expanded subset when a query is active. */
function matchesQuery(node: CommercialCategoryNode, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  if (node.name.toLowerCase().includes(q)) return true;
  return node.children.some((c) => matchesQuery(c, query));
}

export function CategoryTree({
  nodes,
  query,
  canWrite,
  canDelete,
  busyId,
  onToggleActive,
  onRename,
  onCreateChild,
  onDelete,
  onMove,
  onMoveProducts,
}: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [creatingUnder, setCreatingUnder] = useState<string | "root" | null>(null);
  const [createValue, setCreateValue] = useState("");

  const visible = useMemo(() => nodes.filter((n) => matchesQuery(n, query)), [nodes, query]);
  const autoExpand = query.trim().length > 0;

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function startEdit(node: CommercialCategoryNode) {
    setEditingId(node.id);
    setEditValue(node.name);
  }

  function commitEdit(node: CommercialCategoryNode) {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== node.name) onRename(node, trimmed);
    setEditingId(null);
  }

  function startCreate(parentId: string | "root") {
    setCreatingUnder(parentId);
    setCreateValue("");
    if (parentId !== "root") setExpanded((prev) => new Set(prev).add(parentId));
  }

  function commitCreate(parent: CommercialCategoryNode | null) {
    const trimmed = createValue.trim();
    if (trimmed) onCreateChild(parent, trimmed);
    setCreatingUnder(null);
    setCreateValue("");
  }

  function renderNode(node: CommercialCategoryNode, depth: number, siblings: CommercialCategoryNode[]): React.ReactNode {
    const hasChildren = node.children.length > 0;
    const isOpen = autoExpand || expanded.has(node.id);
    const isEditing = editingId === node.id;
    const isBusy = busyId === node.id;
    const idx = siblings.findIndex((s) => s.id === node.id);

    return (
      <div key={node.id}>
        <div
          className={`${css.row} ${!node.isActive ? css.rowInactive : ""}`}
          style={{ paddingLeft: `${0.6 + depth * 1.4}rem` }}
        >
          {hasChildren ? (
            <button
              type="button"
              className={css.disclosure}
              onClick={() => toggleExpand(node.id)}
              aria-label={isOpen ? "Collapse" : "Expand"}
            >
              <IconChevronRight size={14} className={isOpen ? css.disclosureOpen : ""} />
            </button>
          ) : (
            <span className={css.disclosureSpacer} />
          )}

          {isEditing ? (
            <input
              autoFocus
              className={css.formInput}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitEdit(node);
                if (e.key === "Escape") setEditingId(null);
              }}
              onBlur={() => commitEdit(node)}
            />
          ) : (
            <span className={css.rowName}>
              <span className={css.rowNameText}>{node.name}</span>
              {!node.isActive && <span className={css.chip}>Inactive</span>}
              {node.isSystem && <span className={css.chip}>Standard</span>}
            </span>
          )}

          <div className={css.rowMeta}>
            <span className={css.count}>
              {node.productCount} product{node.productCount === 1 ? "" : "s"}
            </span>
            {canWrite && (
              <button
                type="button"
                role="switch"
                aria-checked={node.isActive}
                aria-label={node.isActive ? `Disable ${node.name}` : `Enable ${node.name}`}
                data-tooltip={node.isActive ? "Disable" : "Enable"}
                className={`${css.switch} ${node.isActive ? css.switchOn : ""}`}
                disabled={isBusy}
                onClick={() => onToggleActive(node)}
              >
                <span className={css.switchThumb} />
              </button>
            )}
          </div>

          {canWrite && (
            <div className={css.rowActions}>
              <button
                type="button"
                className={css.iconBtn}
                disabled={idx <= 0 || isBusy}
                aria-label="Move up"
                data-tooltip="Move up"
                onClick={() => onMove(node, "up", siblings)}
              >
                ↑
              </button>
              <button
                type="button"
                className={css.iconBtn}
                disabled={idx === -1 || idx >= siblings.length - 1 || isBusy}
                aria-label="Move down"
                data-tooltip="Move down"
                onClick={() => onMove(node, "down", siblings)}
              >
                ↓
              </button>
              <button
                type="button"
                className={css.iconBtn}
                aria-label={`Add subcategory under ${node.name}`}
                data-tooltip="Add subcategory"
                onClick={() => startCreate(node.id)}
              >
                <IconPlus size={14} />
              </button>
              <button
                type="button"
                className={css.iconBtn}
                aria-label={`Rename ${node.name}`}
                data-tooltip="Rename"
                onClick={() => startEdit(node)}
              >
                <IconEdit size={14} />
              </button>
              {node.productCount > 0 && (
                <button
                  type="button"
                  className={css.iconBtn}
                  aria-label={`Move products out of ${node.name}`}
                  data-tooltip="Move products"
                  onClick={() => onMoveProducts(node)}
                >
                  <IconMoreVertical size={14} />
                </button>
              )}
              {canDelete && !node.isSystem && (
                <button
                  type="button"
                  className={css.iconBtn}
                  aria-label={`Delete ${node.name}`}
                  data-tooltip="Delete"
                  onClick={() => onDelete(node)}
                >
                  <IconTrash size={14} />
                </button>
              )}
            </div>
          )}
        </div>

        {creatingUnder === node.id && (
          <div className={css.formRow} style={{ paddingLeft: `${1.4 + (depth + 1) * 1.4}rem` }}>
            <input
              autoFocus
              className={css.formInput}
              placeholder={`New subcategory under ${node.name}…`}
              value={createValue}
              onChange={(e) => setCreateValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitCreate(node);
                if (e.key === "Escape") setCreatingUnder(null);
              }}
            />
            <button type="button" className={`${css.formBtn} ${css.formBtnPrimary}`} onClick={() => commitCreate(node)}>
              Add
            </button>
            <button type="button" className={css.formBtn} onClick={() => setCreatingUnder(null)}>
              Cancel
            </button>
          </div>
        )}

        {isOpen && node.children.length > 0 && (
          <div>{node.children.map((child) => renderNode(child, depth + 1, node.children))}</div>
        )}
      </div>
    );
  }

  return (
    <div className={css.treeCard}>
      {visible.length === 0 ? (
        <div className={css.treeEmpty}>
          {query ? "No categories match." : "No commercial categories yet."}
        </div>
      ) : (
        visible.map((dept) => renderNode(dept, 0, visible))
      )}

      {canWrite && (
        <div>
          {creatingUnder === "root" ? (
            <div className={css.formRow} style={{ paddingLeft: "0.6rem" }}>
              <input
                autoFocus
                className={css.formInput}
                placeholder="New department name…"
                value={createValue}
                onChange={(e) => setCreateValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitCreate(null);
                  if (e.key === "Escape") setCreatingUnder(null);
                }}
              />
              <button type="button" className={`${css.formBtn} ${css.formBtnPrimary}`} onClick={() => commitCreate(null)}>
                Add
              </button>
              <button type="button" className={css.formBtn} onClick={() => setCreatingUnder(null)}>
                Cancel
              </button>
            </div>
          ) : (
            <div className={css.formRow} style={{ paddingLeft: "0.6rem" }}>
              <button type="button" className={css.formBtn} onClick={() => startCreate("root")}>
                <IconPlus size={13} /> New department
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
