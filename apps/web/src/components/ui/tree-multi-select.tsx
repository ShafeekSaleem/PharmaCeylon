"use client";

import { useEffect, useId, useRef, useState } from "react";
import { IconChevronDown, IconSearch } from "@/components/icons";
import css from "./tree-multi-select.module.css";

export type TreeOption = {
  value: string;
  label: string;
  /** Present only for hierarchical facets (e.g. a commercial category tree). */
  count?: number;
  depth?: number;
  isParent?: boolean;
  parentValue?: string;
};

/** Generic department/category → subcategory tree shape, as returned by
 *  `/catalog/facets`' `commercialDepartments` field. */
export type CategoryTreeNode = {
  id: string;
  label: string;
  canonicalKey: string | null;
  count: number;
  children?: CategoryTreeNode[];
};

/**
 * Nests a flat list of rows (each with an `id` and `parentCategoryId`) into a
 * `CategoryTreeNode[]` tree. Every page that fetches a flat COMMERCIAL category list
 * (Products, Inventory, Reports, …) should build its tree through this one helper instead
 * of re-implementing the same parent/child grouping locally.
 */
export function buildCategoryTree<T extends { id: string; parentCategoryId: string | null }>(
  rows: T[],
  toNode: (row: T, children: CategoryTreeNode[]) => CategoryTreeNode,
): CategoryTreeNode[] {
  const byParent = new Map<string | null, T[]>();
  for (const row of rows) {
    const list = byParent.get(row.parentCategoryId) ?? [];
    list.push(row);
    byParent.set(row.parentCategoryId, list);
  }
  const build = (parentId: string | null): CategoryTreeNode[] =>
    (byParent.get(parentId) ?? []).map((row) => toNode(row, build(row.id)));
  return build(null);
}

/** Flattens a department → category tree into dropdown options, preserving depth/count
 *  as data (not text) so the menu can render real indentation instead of "— " prefixes. */
export function flattenCategoryTree(
  nodes: CategoryTreeNode[] | undefined,
  depth = 0,
  parentValue?: string,
): TreeOption[] {
  if (!nodes) return [];
  const out: TreeOption[] = [];
  for (const node of nodes) {
    out.push({
      value: node.id,
      label: node.label,
      count: node.count,
      depth,
      isParent: !!node.children?.length,
      parentValue,
    });
    out.push(...flattenCategoryTree(node.children, depth + 1, node.id));
  }
  return out;
}

type Props = {
  options: TreeOption[];
  selected: string[];
  onChange: (values: string[]) => void;
  searchPlaceholder: string;
  searchable?: boolean;
  /** Where the menu opens relative to the trigger. "bottom" (default) is the standard
   *  dropdown behavior for inline horizontal toolbars; "right" suits narrow, vertically-
   *  stacked filter rows where opening downward could get clipped. */
  menuPlacement?: "bottom" | "right";
  /** Shown as a small label inside the trigger, above the value — matches
   *  `InventoryFilterSelect`'s two-line trigger so the two components align when placed
   *  side by side in the same toolbar row. Omit to keep the compact single-line trigger. */
  label?: string;
  /** Extra class(es) merged onto the root wrapper, e.g. to size the trigger in a specific page. */
  className?: string;
};

/**
 * Multi-select dropdown. Plain option lists (no `depth`) behave as a simple checkbox
 * multi-select. Hierarchical option lists (from `flattenCategoryTree`) additionally get:
 * collapsed-by-default parent rows with an expand chevron, and cascading selection
 * (checking a parent checks/covers all its children; unchecking a child while its parent
 * is selected "splits" the selection so the other children stay checked).
 */
export function TreeMultiSelect({
  options,
  selected,
  onChange,
  searchPlaceholder,
  searchable = true,
  menuPlacement = "bottom",
  label,
  className,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Tree facets start collapsed to parents-only; expanding a department reveals its
  // children. Not used by flat (non-tree) option lists.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const listId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) {
      setQuery("");
      setExpanded(new Set());
      return;
    }
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node;
      if (
        menuRef.current?.contains(target) ||
        triggerRef.current?.contains(target)
      ) {
        return;
      }
      setMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const hasQuery = searchable && query.trim().length > 0;
  const searchFiltered = hasQuery
    ? options.filter((o) => o.label.toLowerCase().includes(query.trim().toLowerCase()))
    : options;
  // While searching, show flat matches regardless of collapse state. Otherwise, a child
  // is only visible once its parent has been expanded (parents-only by default).
  const filtered = hasQuery
    ? searchFiltered
    : searchFiltered.filter(
        (o) => o.depth === undefined || o.depth === 0 || (o.parentValue && expanded.has(o.parentValue)),
      );

  const summary =
    selected.length === 0
      ? options.length
        ? "All"
        : "—"
      : selected.length === 1
        ? (options.find((o) => o.value === selected[0])?.label ?? selected[0])
        : `${selected.length} selected`;

  const toggleExpand = (value: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  };

  /** A child reads as checked either explicitly, or because its whole parent is selected. */
  const isChecked = (opt: TreeOption) =>
    selected.includes(opt.value) || (!!opt.parentValue && selected.includes(opt.parentValue));

  const toggle = (opt: TreeOption) => {
    if (opt.depth === undefined) {
      // Flat (non-tree) option list — plain toggle.
      onChange(
        selected.includes(opt.value)
          ? selected.filter((v) => v !== opt.value)
          : [...selected, opt.value],
      );
      return;
    }

    if (opt.isParent) {
      const childValues = options.filter((o) => o.parentValue === opt.value).map((o) => o.value);
      if (selected.includes(opt.value)) {
        // Deselect the department and any of its children still selected individually.
        onChange(selected.filter((v) => v !== opt.value && !childValues.includes(v)));
      } else {
        // Selecting a department covers every child — drop redundant child ids, keep just
        // the parent id, and expand it so the now-checked children are visible.
        onChange([...selected.filter((v) => !childValues.includes(v)), opt.value]);
        setExpanded((prev) => new Set(prev).add(opt.value));
      }
      return;
    }

    const parentId = opt.parentValue;
    if (parentId && selected.includes(parentId)) {
      // Parent is selected (covering all children implicitly) — unchecking one child means
      // dropping the parent id and explicitly keeping every *other* sibling checked.
      const siblingIds = options
        .filter((o) => o.parentValue === parentId && o.value !== opt.value)
        .map((o) => o.value);
      onChange([...selected.filter((v) => v !== parentId), ...siblingIds]);
      return;
    }

    let next = selected.includes(opt.value)
      ? selected.filter((v) => v !== opt.value)
      : [...selected, opt.value];

    // If every sibling is now individually selected, collapse them into the parent id.
    if (parentId) {
      const siblingIds = options.filter((o) => o.parentValue === parentId).map((o) => o.value);
      if (siblingIds.length > 0 && siblingIds.every((v) => next.includes(v))) {
        next = [...next.filter((v) => !siblingIds.includes(v)), parentId];
      }
    }
    onChange(next);
  };

  return (
    <div className={`${css.multiWrap} ${className ?? ""}`}>
      <button
        ref={triggerRef}
        type="button"
        className={`${css.multiTrigger} ${label ? css.multiTriggerLabeled : ""} ${
          menuOpen ? css.multiTriggerOpen : ""
        } ${selected.length > 0 ? css.multiTriggerFiltered : ""}`}
        onClick={() => setMenuOpen((o) => !o)}
        aria-expanded={menuOpen}
        aria-controls={listId}
      >
        {label ? (
          <span className={css.multiTriggerText}>
            <span className={css.multiTriggerLabel}>{label}</span>
            <span className={css.multiSummary}>{summary}</span>
          </span>
        ) : (
          <span className={css.multiSummary}>{summary}</span>
        )}
        <IconChevronDown size={14} className={css.multiChevron} />
      </button>

      {menuOpen && (
        <div
          ref={menuRef}
          id={listId}
          className={`${css.multiMenu} ${
            menuPlacement === "right" ? css.multiMenuRight : css.multiMenuBottom
          }`}
          role="listbox"
        >
          {searchable && (
            <div className={css.multiSearch}>
              <IconSearch size={14} className={css.multiSearchIcon} />
              <input
                type="text"
                className={css.multiSearchInput}
                placeholder={searchPlaceholder}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoFocus
              />
            </div>
          )}
          <ul className={css.multiList}>
            {filtered.length === 0 ? (
              <li className={css.multiEmpty}>No matches</li>
            ) : (
              filtered.map((opt, idx) => {
                const depth = opt.depth ?? 0;
                const hasTree = opt.depth !== undefined;
                const isParent = hasTree && opt.isParent;
                const isExpanded = isParent && expanded.has(opt.value);
                return (
                  <li key={opt.value}>
                    <div
                      className={`${hasTree ? css.multiOptionRow : ""} ${
                        isParent ? css.multiOptionParent : ""
                      } ${isParent && idx > 0 ? css.multiOptionParentDivider : ""} ${
                        hasTree && !opt.isParent && depth > 0 ? css.multiOptionChild : ""
                      }`}
                      style={hasTree ? { paddingLeft: `${0.4 + depth * 1.05}rem` } : undefined}
                    >
                      {hasTree &&
                        (isParent ? (
                          <button
                            type="button"
                            className={css.multiExpandBtn}
                            onClick={() => toggleExpand(opt.value)}
                            aria-expanded={isExpanded}
                            aria-label={isExpanded ? `Collapse ${opt.label}` : `Expand ${opt.label}`}
                          >
                            <IconChevronDown
                              size={12}
                              className={`${css.multiExpandChevron} ${
                                isExpanded ? css.multiExpandChevronOpen : ""
                              }`}
                            />
                          </button>
                        ) : (
                          <span className={css.multiExpandSpacer} aria-hidden="true" />
                        ))}
                      <label className={hasTree ? css.multiOptionCheck : css.multiOption}>
                        <input
                          type="checkbox"
                          checked={hasTree ? isChecked(opt) : selected.includes(opt.value)}
                          onChange={() => toggle(opt)}
                        />
                        <span className={css.multiOptionLabel}>{opt.label}</span>
                        {opt.count !== undefined && (
                          <span className={css.multiOptionCount}>{opt.count}</span>
                        )}
                      </label>
                    </div>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
