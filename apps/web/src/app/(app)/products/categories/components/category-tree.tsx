"use client";

import { useMemo, useState } from "react";
import { IconChevronDown, IconChevronRight, IconChevronUp, IconPlus } from "@/components/icons";
import { RowMenu, ToggleSwitch } from "@/components/ui";
import type { CommercialCategoryNode } from "../types";
import css from "../categories.module.css";

type Props = {
  nodes: CommercialCategoryNode[];
  query: string;
  canWrite: boolean;
  canDelete: boolean;
  busyId: string | null;
  /** Off by default — see the display option in CategoriesSection for why. */
  showReferenceCounts?: boolean;
  onToggleActive: (node: CommercialCategoryNode) => void;
  onRequestAddChild: (parent: CommercialCategoryNode) => void;
  onRequestRename: (node: CommercialCategoryNode) => void;
  onDelete: (node: CommercialCategoryNode) => void;
  onMove: (
    node: CommercialCategoryNode,
    direction: "up" | "down",
    siblings: CommercialCategoryNode[],
  ) => void;
  onMoveProducts: (node: CommercialCategoryNode) => void;
};

function matchesQuery(node: CommercialCategoryNode, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  if (node.name.toLowerCase().includes(q)) return true;
  return node.children.some((c) => matchesQuery(c, query));
}

/**
 * The commercial category tree: departments, each holding its categories.
 *
 * Rewritten because the flat version read as one undifferentiated list of forty rows. Three
 * things were doing the damage, and each is fixed here rather than restyled:
 *
 * - **Every row carried a "Standard" chip.** Twenty repetitions of the same word carry no
 *   information. The informative case is the inverse — a category this pharmacy created — so
 *   only those are chipped now.
 * - **Four controls on every row, always.** A toggle, two reorder arrows and an overflow menu,
 *   on rows nobody was editing — twenty bright switches for a state that is almost always
 *   "on". They appear on hover or keyboard focus now, and the exception carries a "Hidden"
 *   chip, so the one piece of state worth seeing at a glance is the one still visible.
 * - **Departments and their children looked identical.** A department is now a card header
 *   with its own summary line, and its children sit inside against a guide rail, so the shape
 *   of the tree is visible without reading any of it.
 */
export function CategoryTree({
  nodes,
  query,
  canWrite,
  canDelete,
  busyId,
  showReferenceCounts = false,
  onToggleActive,
  onRequestAddChild,
  onRequestRename,
  onDelete,
  onMove,
  onMoveProducts,
}: Props) {
  /*
   * Departments start closed. Expanded, this is eighty near-identical rows and the shape of the
   * tree is invisible; closed, it is eight lines that each say what is inside. A search opens
   * everything, because a match nobody can see is not a match.
   */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const visible = useMemo(() => nodes.filter((n) => matchesQuery(n, query)), [nodes, query]);
  const searching = query.trim().length > 0;

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (visible.length === 0) {
    return (
      <div className={css.treeCard}>
        <div className={css.treeEmpty}>
          {query ? "No categories match." : "No commercial categories yet."}
        </div>
      </div>
    );
  }

  return (
    <div className={css.tree}>
      {visible.map((dept) => {
        const open = searching || expanded.has(dept.id);
        const children = dept.children.filter((c) => matchesQuery(c, query));
        return (
          <section
            key={dept.id}
            className={`${css.dept}${dept.isActive ? "" : ` ${css.deptOff}`}`}
          >
            <header className={css.deptHead}>
              <button
                type="button"
                className={css.deptDisclosure}
                onClick={() => toggleExpand(dept.id)}
                aria-expanded={open}
                aria-label={`${open ? "Collapse" : "Expand"} ${dept.name}`}
                disabled={children.length === 0}
              >
                {children.length > 0 ? (
                  <IconChevronRight size={14} className={open ? css.disclosureOpen : undefined} />
                ) : (
                  <span className={css.disclosureDot} aria-hidden />
                )}
              </button>

              <div
                className={css.deptTitleWrap}
                role={children.length > 0 ? "presentation" : undefined}
                onClick={children.length > 0 ? () => toggleExpand(dept.id) : undefined}
              >
                <h3 className={css.deptTitle}>{dept.name}</h3>
                <p className={css.deptSummary}>
                  {children.length > 0 && (
                    <>
                      {children.length} categor{children.length === 1 ? "y" : "ies"}
                      <span className={css.dot} aria-hidden>
                        ·
                      </span>
                    </>
                  )}
                  {dept.rangedCount.toLocaleString()} product
                  {dept.rangedCount === 1 ? "" : "s"}
                  {showReferenceCounts && dept.referenceCount > 0 && (
                    <>
                      <span className={css.dot} aria-hidden>
                        ·
                      </span>
                      <span className={css.countMuted}>
                        {dept.referenceCount.toLocaleString()} reference
                      </span>
                    </>
                  )}
                </p>
              </div>

              {/* Words as well as opacity — a disabled department must not read as "just faded". */}
              {!dept.isActive && <span className={css.offChip}>Hidden</span>}
              {!dept.isSystem && <span className={css.customChip}>Custom</span>}

              {canWrite && (
                <div className={css.deptActions}>
                  <div className={css.hoverActions}>
                    <ReorderButtons
                      node={dept}
                      siblings={visible}
                      busy={busyId === dept.id}
                      onMove={onMove}
                    />
                    <button
                      type="button"
                      className={css.iconBtn}
                      aria-label={`Add a category under ${dept.name}`}
                      data-tooltip="Add category"
                      onClick={() => onRequestAddChild(dept)}
                    >
                      <IconPlus size={14} />
                    </button>
                    <ToggleSwitch
                      checked={dept.isActive}
                      onChange={() => onToggleActive(dept)}
                      disabled={busyId === dept.id}
                      label={dept.isActive ? `Hide ${dept.name}` : `Show ${dept.name}`}
                    />
                  </div>
                  <RowMenu
                    label={dept.name}
                    actions={rowActions(
                      dept,
                      canDelete,
                      onRequestRename,
                      onRequestAddChild,
                      onMoveProducts,
                      onDelete,
                    )}
                  />
                </div>
              )}
            </header>

            {open && children.length > 0 && (
              <ul className={css.childList}>
                {children.map((child) => (
                  <li
                    key={child.id}
                    className={`${css.child}${child.isActive ? "" : ` ${css.childOff}`}`}
                  >
                    <span className={css.childName}>{child.name}</span>
                    {!child.isActive && <span className={css.offChip}>Hidden</span>}
                    {!child.isSystem && <span className={css.customChip}>Custom</span>}

                    <span className={css.childCount}>
                      {child.rangedCount.toLocaleString()}
                      {showReferenceCounts && child.referenceCount > 0 && (
                        <span className={css.countMuted}>
                          {" "}
                          / {child.referenceCount.toLocaleString()} ref
                        </span>
                      )}
                    </span>

                    {canWrite && (
                      <div className={css.childActions}>
                        <div className={css.hoverActions}>
                          <ReorderButtons
                            node={child}
                            siblings={dept.children}
                            busy={busyId === child.id}
                            onMove={onMove}
                          />
                          <ToggleSwitch
                            checked={child.isActive}
                            onChange={() => onToggleActive(child)}
                            disabled={busyId === child.id}
                            label={child.isActive ? `Hide ${child.name}` : `Show ${child.name}`}
                          />
                        </div>
                        <RowMenu
                          label={child.name}
                          actions={rowActions(
                            child,
                            canDelete,
                            onRequestRename,
                            onRequestAddChild,
                            onMoveProducts,
                            onDelete,
                          )}
                        />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {open && children.length === 0 && canWrite && (
              <p className={css.childEmpty}>
                Nothing filed under {dept.name} yet.{" "}
                <button
                  type="button"
                  className={css.inlineAction}
                  onClick={() => onRequestAddChild(dept)}
                >
                  Add a category
                </button>
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
}

function ReorderButtons({
  node,
  siblings,
  busy,
  onMove,
}: {
  node: CommercialCategoryNode;
  siblings: CommercialCategoryNode[];
  busy: boolean;
  onMove: Props["onMove"];
}) {
  const idx = siblings.findIndex((s) => s.id === node.id);
  return (
    <>
      <button
        type="button"
        className={css.iconBtn}
        disabled={idx <= 0 || busy}
        aria-label={`Move ${node.name} up`}
        data-tooltip="Move up"
        onClick={() => onMove(node, "up", siblings)}
      >
        <IconChevronUp size={13} />
      </button>
      <button
        type="button"
        className={css.iconBtn}
        disabled={idx === -1 || idx >= siblings.length - 1 || busy}
        aria-label={`Move ${node.name} down`}
        data-tooltip="Move down"
        onClick={() => onMove(node, "down", siblings)}
      >
        <IconChevronDown size={13} />
      </button>
    </>
  );
}

function rowActions(
  node: CommercialCategoryNode,
  canDelete: boolean,
  onRequestRename: Props["onRequestRename"],
  onRequestAddChild: Props["onRequestAddChild"],
  onMoveProducts: Props["onMoveProducts"],
  onDelete: Props["onDelete"],
) {
  return [
    { label: "Rename", onClick: () => onRequestRename(node) },
    { label: "Add subcategory", onClick: () => onRequestAddChild(node) },
    ...(node.productCount > 0
      ? [{ label: "Move products out…", onClick: () => onMoveProducts(node) }]
      : []),
    ...(canDelete
      ? [
          {
            label: "Delete",
            danger: true,
            separated: true,
            onClick: () => onDelete(node),
            hint: node.isSystem
              ? "Standard categories can be hidden, not deleted"
              : node.productCount > 0
                ? "Move its products out first"
                : undefined,
          },
        ]
      : []),
  ];
}
