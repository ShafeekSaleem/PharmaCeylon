"use client";

import { useMemo, useState } from "react";
import {
  IconChevronDown,
  IconChevronRight,
  IconChevronUp,
  IconEdit,
  IconPlus,
  IconRefresh,
  IconTrash,
} from "@/components/icons";
import { ToggleSwitch } from "@/components/ui";
import type { CommercialCategoryNode } from "../types";
import css from "../categories.module.css";

type Props = {
  nodes: CommercialCategoryNode[];
  query: string;
  canWrite: boolean;
  canDelete: boolean;
  busyId: string | null;
  onToggleActive: (node: CommercialCategoryNode) => void;
  onRequestAddChild: (parent: CommercialCategoryNode) => void;
  onRequestRename: (node: CommercialCategoryNode) => void;
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
  onRequestAddChild,
  onRequestRename,
  onDelete,
  onMove,
  onMoveProducts,
}: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

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

  function renderNode(node: CommercialCategoryNode, depth: number, siblings: CommercialCategoryNode[]): React.ReactNode {
    const hasChildren = node.children.length > 0;
    const isOpen = autoExpand || expanded.has(node.id);
    const isBusy = busyId === node.id;
    const idx = siblings.findIndex((s) => s.id === node.id);
    const isDept = depth === 0;

    return (
      <div key={node.id} className={isDept ? css.deptGroup : undefined}>
        <div
          className={`${css.row}${isDept ? ` ${css.rowDept}` : ""}${!node.isActive ? ` ${css.rowInactive}` : ""}`}
          style={{ paddingLeft: `${0.6 + depth * 1.5}rem` }}
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

          <span className={css.rowName}>
            <span className={css.rowNameText}>{node.name}</span>
            {!node.isActive && <span className={css.chip}>Inactive</span>}
            {node.isSystem && <span className={css.chip}>Standard</span>}
          </span>

          <div className={css.rowMeta}>
            <span className={css.count}>
              {node.productCount} product{node.productCount === 1 ? "" : "s"}
            </span>
            {canWrite && (
              <ToggleSwitch
                checked={node.isActive}
                onChange={() => onToggleActive(node)}
                disabled={isBusy}
                label={node.isActive ? `Disable ${node.name}` : `Enable ${node.name}`}
              />
            )}
          </div>

          {canWrite && (
            <div className={css.rowActions}>
              <div className={css.reorderGroup}>
                <button
                  type="button"
                  className={css.iconBtn}
                  disabled={idx <= 0 || isBusy}
                  aria-label="Move up"
                  data-tooltip="Move up"
                  onClick={() => onMove(node, "up", siblings)}
                >
                  <IconChevronUp size={13} />
                </button>
                <button
                  type="button"
                  className={css.iconBtn}
                  disabled={idx === -1 || idx >= siblings.length - 1 || isBusy}
                  aria-label="Move down"
                  data-tooltip="Move down"
                  onClick={() => onMove(node, "down", siblings)}
                >
                  <IconChevronDown size={13} />
                </button>
              </div>
              <button
                type="button"
                className={css.iconBtn}
                aria-label={`Add subcategory under ${node.name}`}
                data-tooltip="Add subcategory"
                onClick={() => onRequestAddChild(node)}
              >
                <IconPlus size={14} />
              </button>
              <button
                type="button"
                className={css.iconBtn}
                aria-label={`Rename ${node.name}`}
                data-tooltip="Rename"
                onClick={() => onRequestRename(node)}
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
                  <IconRefresh size={14} />
                </button>
              )}
              {canDelete && !node.isSystem && (
                <button
                  type="button"
                  className={`${css.iconBtn} ${css.iconBtnDanger}`}
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
    </div>
  );
}
