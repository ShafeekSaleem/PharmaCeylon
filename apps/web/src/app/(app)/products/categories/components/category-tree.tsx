"use client";

import { useMemo, useState } from "react";
import { IconChevronRight } from "@/components/icons";
import { RowMenu } from "@/components/ui";
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
  onMoveProducts: (node: CommercialCategoryNode) => void;
};

function matchesQuery(node: CommercialCategoryNode, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  if (node.name.toLowerCase().includes(q)) return true;
  return node.children.some((c) => matchesQuery(c, query));
}

/**
 * Biggest first. The bar and the capsules under it read in the same order, so the widest,
 * darkest segment and the first capsule are the same subcategory — which is what makes the bar
 * worth reading at all rather than being decoration.
 */
function byProductCount(
  a: CommercialCategoryNode,
  b: CommercialCategoryNode,
): number {
  return b.rangedCount - a.rangedCount || a.name.localeCompare(b.name);
}

/** Share of the bar an empty subcategory keeps, so it stays visible as a sliver. */
const EMPTY_SEGMENT_SHARE = 0.35;
/** Faintest a filled segment gets, so the smallest one is still clearly "stocked". */
const MIN_SEGMENT_OPACITY = 0.4;

/**
 * The commercial category tree: departments, each holding its categories.
 *
 * Now a table, because that is what this is — one row per department, the same three numbers on
 * every row, read down the column. The versions before it were a flat list of forty
 * near-identical rows, then cards in a grid; both spent most of their width on furniture, and
 * the grid made "which department has the most in it" a question you answered by reading rather
 * than by looking.
 *
 * Each row carries a distribution bar: one segment per subcategory, ordered biggest-first and
 * shaded from strong to faint, so the shape of a department is legible before it is opened.
 * Opening one closes whichever was open and expands beneath its row, listing the same
 * subcategories in the same order as capsules.
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
  onMoveProducts,
}: Props) {
  /*
   * Departments start closed, and only one opens at a time. Searching is the exception: every
   * matching department opens together, because a match hidden behind a closed row is not a
   * match.
   */
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const visible = useMemo(
    () => nodes.filter((n) => matchesQuery(n, query)),
    [nodes, query],
  );
  const searching = query.trim().length > 0;

  function toggleExpand(id: string) {
    setExpandedId((prev) => (prev === id ? null : id));
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

  const columnCount = showReferenceCounts ? 5 : 4;

  return (
    <div className={css.tableWrap}>
      <table className={css.table}>
        <thead>
          <tr>
            <th scope="col" className={css.colName}>
              Category
            </th>
            <th scope="col" className={`${css.colNum} ${css.colSubs}`}>
              Subcategories
            </th>
            <th scope="col" className={css.colNum}>
              Products
            </th>
            {showReferenceCounts && (
              <th scope="col" className={css.colNum}>
                Reference
              </th>
            )}
            <th scope="col" className={css.colDist}>
              Distribution
            </th>
            <th scope="col" className={css.colActions}>
              <span className={css.srOnly}>Actions</span>
            </th>
          </tr>
        </thead>

        {visible.map((dept) => {
          const open = searching || expandedId === dept.id;
          const children = dept.children
            .filter((c) => matchesQuery(c, query))
            .sort(byProductCount);

          return (
            <tbody
              key={dept.id}
              className={`${css.group}${open ? ` ${css.groupOpen}` : ""}${
                dept.isActive ? "" : ` ${css.groupOff}`
              }`}
            >
              <tr className={css.row}>
                <th scope="row" className={css.cellName}>
                  <button
                    type="button"
                    className={css.disclosure}
                    onClick={() => toggleExpand(dept.id)}
                    aria-expanded={open}
                    aria-label={`${open ? "Collapse" : "Expand"} ${dept.name}`}
                    disabled={children.length === 0}
                  >
                    <IconChevronRight
                      size={14}
                      className={`${css.chevron}${open ? ` ${css.chevronOpen}` : ""}`}
                      aria-hidden
                    />
                    <span className={css.name} title={dept.name}>
                      {dept.name}
                    </span>
                  </button>
                  {/* Words as well as opacity — a hidden department must not read as "just faded". */}
                  {!dept.isActive && <span className={css.offChip}>Hidden</span>}
                  {!dept.isSystem && (
                    <span className={css.customChip}>Custom</span>
                  )}
                </th>

                <td className={`${css.cellNum} ${css.cellSubs}`}>
                  {children.length > 0 ? (
                    children.length
                  ) : (
                    <span className={css.zero}>—</span>
                  )}
                </td>

                <td className={css.cellNum}>
                  {dept.rangedCount > 0 ? (
                    dept.rangedCount.toLocaleString()
                  ) : (
                    <span className={css.zero}>0</span>
                  )}
                </td>

                {showReferenceCounts && (
                  <td className={`${css.cellNum} ${css.cellNumMuted}`}>
                    {dept.referenceCount.toLocaleString()}
                  </td>
                )}

                <td className={css.cellDist}>
                  {children.length > 0 ? (
                    <DistributionBar subcategories={children} />
                  ) : (
                    <span className={css.zero}>—</span>
                  )}
                </td>

                <td className={css.cellActions}>
                  {canWrite && (
                    <RowMenu
                      label={dept.name}
                      actions={rowActions(dept, {
                        canDelete,
                        busy: busyId === dept.id,
                        isDepartment: true,
                        onRequestRename,
                        onRequestAddChild,
                        onToggleActive,
                        onMoveProducts,
                        onDelete,
                      })}
                    />
                  )}
                </td>
              </tr>

              {open && children.length > 0 && (
                <tr className={css.expansionRow}>
                  <td className={css.expansionCell} colSpan={columnCount + 1}>
                    <div className={css.expansionHead}>
                      <span className={css.expansionLabel}>Subcategories</span>
                      <span className={css.expansionHint}>
                        Ordered by product count
                      </span>
                    </div>
                    <ul
                      className={`${css.capsules}${
                        showReferenceCounts
                          ? ` ${css.capsulesWithReference}`
                          : ""
                      }`}
                    >
                      {children.map((child) => (
                        <li
                          key={child.id}
                          className={`${css.capsule}${child.isActive ? "" : ` ${css.capsuleOff}`}`}
                        >
                          <span className={css.capsuleName} title={child.name}>
                            {child.name}
                          </span>
                          {!child.isActive && (
                            <span className={css.offChip}>Hidden</span>
                          )}
                          {!child.isSystem && (
                            <span className={css.customChip}>Custom</span>
                          )}

                          <span className={css.capsuleCounts}>
                            <span
                              className={`${css.countBadge}${
                                child.rangedCount > 0
                                  ? ` ${css.countBadgeFilled}`
                                  : ""
                              }`}
                              aria-label={`${child.rangedCount.toLocaleString()} products`}
                            >
                              {child.rangedCount.toLocaleString()}
                            </span>
                            {/* Same pill, different colour: the shop's own count is the one
                                being acted on, the register's is context beside it. */}
                            {showReferenceCounts && child.referenceCount > 0 && (
                              <span
                                className={`${css.countBadge} ${css.countBadgeReference}`}
                                aria-label={`${child.referenceCount.toLocaleString()} reference-catalog products`}
                              >
                                {child.referenceCount.toLocaleString()}
                              </span>
                            )}
                          </span>

                          {canWrite && (
                            <RowMenu
                              label={child.name}
                              actions={rowActions(child, {
                                canDelete,
                                busy: busyId === child.id,
                                isDepartment: false,
                                onRequestRename,
                                onRequestAddChild,
                                onToggleActive,
                                onMoveProducts,
                                onDelete,
                              })}
                            />
                          )}
                        </li>
                      ))}
                    </ul>
                  </td>
                </tr>
              )}

              {open && children.length === 0 && canWrite && (
                <tr className={css.expansionRow}>
                  <td className={css.expansionCell} colSpan={columnCount + 1}>
                    <p className={css.expansionEmpty}>
                      Nothing filed under {dept.name} yet.{" "}
                      <button
                        type="button"
                        className={css.inlineAction}
                        onClick={() => onRequestAddChild(dept)}
                      >
                        Add a category
                      </button>
                    </p>
                  </td>
                </tr>
              )}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}

/**
 * One segment per subcategory, ordered biggest-first, width proportional to its product count
 * and shaded strong-to-faint down that order. A subcategory with nothing filed under it still
 * gets `EMPTY_SEGMENT_SHARE` worth of width in neutral grey rather than disappearing — the bar
 * answers "how many subcategories, and how full are they", not only "where the stock is".
 *
 * Decorative (aria-hidden): the numbers either side of it already state the same thing, so
 * nothing here is carried by colour alone.
 */
function DistributionBar({
  subcategories,
}: {
  subcategories: CommercialCategoryNode[];
}) {
  const filled = subcategories.filter((c) => c.rangedCount > 0).length;
  let rank = 0;

  return (
    <div className={css.distribution} aria-hidden="true">
      {subcategories.map((child) => {
        const isFilled = child.rangedCount > 0;
        // Even steps from full strength down to MIN_SEGMENT_OPACITY across the filled segments.
        const opacity = isFilled
          ? 1 - (rank++ / Math.max(1, filled - 1)) * (1 - MIN_SEGMENT_OPACITY)
          : undefined;
        return (
          <span
            key={child.id}
            data-testid="category-distribution-segment"
            className={isFilled ? css.segmentFilled : css.segmentEmpty}
            style={{
              flexGrow: isFilled ? child.rangedCount : EMPTY_SEGMENT_SHARE,
              opacity,
            }}
          />
        );
      })}
    </div>
  );
}

function rowActions(
  node: CommercialCategoryNode,
  {
    canDelete,
    busy,
    isDepartment,
    onRequestRename,
    onRequestAddChild,
    onToggleActive,
    onMoveProducts,
    onDelete,
  }: {
    canDelete: boolean;
    busy: boolean;
    /** Departments hold categories; a category holds products. The tree is two levels. */
    isDepartment: boolean;
  } & Pick<
    Props,
    | "onRequestRename"
    | "onRequestAddChild"
    | "onToggleActive"
    | "onMoveProducts"
    | "onDelete"
  >,
) {
  return [
    { label: "Rename", onClick: () => onRequestRename(node) },
    // Offered on departments only. A subcategory's children would be a third level the tree
    // does not render, so the action created categories nobody could then see.
    ...(isDepartment
      ? [
          {
            label: "Add subcategory",
            onClick: () => onRequestAddChild(node),
          },
        ]
      : []),
    {
      label: node.isActive ? "Hide" : "Show",
      hint: node.isActive
        ? "Keeps it off the Products filter, POS and onboarding"
        : "Offer it again everywhere it's chosen",
      disabled: busy,
      onClick: () => onToggleActive(node),
    },
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
