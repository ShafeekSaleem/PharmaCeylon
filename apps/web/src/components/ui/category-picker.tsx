"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { IconCheck, IconChevronDown, IconSearch } from "@/components/icons";
import css from "./category-picker.module.css";

export type CategoryPickerNode = {
  id: string;
  name: string;
  parentCategoryId: string | null;
};

/** An extra choice offered under a divider — "move back to Unclassified", and the like. */
export type CategoryPickerExtra = {
  value: string;
  label: string;
  hint?: string;
};

type Props = {
  categories: CategoryPickerNode[];
  value: string;
  onChange: (value: string) => void;
  /** Accessible name for the trigger. Never rendered. */
  label: string;
  placeholder?: string;
  /** Ids that cannot be chosen, each mapped to the reason shown beside it. */
  disabledReasons?: Record<string, string>;
  /** Extra text after a name — a count, a coverage note. */
  meta?: (id: string) => string | null;
  extra?: CategoryPickerExtra;
  /** Row-height trigger for use inside a dense table. */
  compact?: boolean;
  disabled?: boolean;
  className?: string;
};

const GAP = 4;
const VIEWPORT_MARGIN = 8;
const MIN_MENU_WIDTH = 260;
const MAX_MENU_HEIGHT = 320;

type MenuPosition = { top?: number; bottom?: number; left: number; width: number };

/**
 * Choose one commercial category, department and subcategory alike, from a tree you expand
 * rather than a list you scroll.
 *
 * The flat `<select>` this replaces printed every department and every subcategory as one
 * hundred-odd sibling options, with the hierarchy carried only by an indent character — so the
 * two places a category is chosen (the bulk dialog and the Work Queue) looked nothing like the
 * category filter on Products, which had had the expanding tree all along. This is that tree,
 * as a single-select, so all three now behave the same way.
 *
 * `disabledReasons` is what makes it more than a nicer dropdown: a dialog acting on a selection
 * can grey out the category those products are already filed under and say so, instead of
 * offering it and reporting "0 products updated".
 *
 * The menu is portalled to the body at viewport coordinates — a table cell and a modal both
 * clip an absolutely-positioned menu at their own edge.
 */
export function CategoryPicker({
  categories,
  value,
  onChange,
  label,
  placeholder = "Choose a category…",
  disabledReasons,
  meta,
  extra,
  compact = false,
  disabled = false,
  className,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const { departments, childrenOf, byId } = useMemo(() => {
    const map = new Map<string, CategoryPickerNode>();
    const kids = new Map<string, CategoryPickerNode[]>();
    for (const node of categories) map.set(node.id, node);
    for (const node of categories) {
      if (!node.parentCategoryId) continue;
      const list = kids.get(node.parentCategoryId) ?? [];
      list.push(node);
      kids.set(node.parentCategoryId, list);
    }
    return {
      departments: categories.filter((c) => !c.parentCategoryId),
      childrenOf: kids,
      byId: map,
    };
  }, [categories]);

  /**
   * The department the chosen subcategory belongs to. The answer is a path, so both halves of
   * it are marked: the subcategory as chosen, its department as the branch containing the
   * choice. Highlighting only the leaf left the open menu looking as though nothing upstream
   * of it had been decided.
   */
  const selectedParentId = useMemo(
    () => (value ? (byId.get(value)?.parentCategoryId ?? null) : null),
    [byId, value],
  );

  /** "Medicines › Analgesics" — the whole answer, not just its last word. */
  const selectedPath = useMemo(() => {
    if (extra && value === extra.value) return extra.label;
    const node = byId.get(value);
    if (!node) return null;
    const parent = node.parentCategoryId
      ? byId.get(node.parentCategoryId)
      : null;
    return parent ? `${parent.name} › ${node.name}` : node.name;
  }, [byId, extra, value]);

  const place = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    const width = Math.min(
      Math.max(rect.width, MIN_MENU_WIDTH),
      viewportWidth - VIEWPORT_MARGIN * 2,
    );
    const dropUp =
      rect.bottom + MAX_MENU_HEIGHT > window.innerHeight &&
      rect.top > MAX_MENU_HEIGHT;
    setPosition({
      top: dropUp ? undefined : rect.bottom + GAP,
      bottom: dropUp ? window.innerHeight - rect.top + GAP : undefined,
      left: Math.min(
        Math.max(VIEWPORT_MARGIN, rect.left),
        viewportWidth - width - VIEWPORT_MARGIN,
      ),
      width,
    });
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    // Open onto the current answer rather than onto a collapsed list it is hidden inside.
    if (selectedParentId) {
      setExpanded((prev) =>
        prev.has(selectedParentId) ? prev : new Set(prev).add(selectedParentId),
      );
    }
    function onPointer(e: MouseEvent) {
      const target = e.target as Node;
      if (
        triggerRef.current?.contains(target) ||
        menuRef.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    }
    function reposition() {
      place();
    }
    document.addEventListener("mousedown", onPointer);
    // Capture, so Escape closes this menu rather than the modal it may be sitting inside —
    // the innermost open thing is what the key is aimed at.
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open, place, selectedParentId]);

  const searching = query.trim().length > 0;
  const needle = query.trim().toLowerCase();

  /** Rows to draw: departments always, children when expanded — or when they match a search. */
  const rows = useMemo(() => {
    const out: Array<{ node: CategoryPickerNode; depth: number }> = [];
    for (const dept of departments) {
      const kids = childrenOf.get(dept.id) ?? [];
      const deptMatches = dept.name.toLowerCase().includes(needle);
      const matchingKids = searching
        ? kids.filter((k) => k.name.toLowerCase().includes(needle))
        : kids;
      if (searching && !deptMatches && matchingKids.length === 0) continue;
      out.push({ node: dept, depth: 0 });
      // A search shows what it found without asking for a second click; otherwise a
      // department stays collapsed until it is opened.
      if (searching || expanded.has(dept.id)) {
        for (const kid of matchingKids) out.push({ node: kid, depth: 1 });
      }
    }
    return out;
  }, [childrenOf, departments, expanded, needle, searching]);

  function pick(next: string) {
    onChange(next);
    setOpen(false);
  }

  const menu = open && position && (
    <div
      ref={menuRef}
      className={css.menu}
      style={{
        top: position.top,
        bottom: position.bottom,
        left: position.left,
        width: position.width,
      }}
      role="dialog"
      aria-label={label}
    >
      <div className={css.search}>
        <IconSearch size={14} className={css.searchIcon} aria-hidden />
        <input
          type="text"
          className={css.searchInput}
          placeholder="Search categories…"
          aria-label="Search categories"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
      </div>

      <ul className={css.list} role="listbox" aria-label={label}>
        {rows.length === 0 && <li className={css.empty}>No categories match.</li>}

        {rows.map(({ node, depth }) => {
          const kids = childrenOf.get(node.id) ?? [];
          const isOpen = searching || expanded.has(node.id);
          const reason = disabledReasons?.[node.id];
          const note = meta?.(node.id) ?? null;
          const selected = value === node.id;
          const onSelectedPath = node.id === selectedParentId;

          return (
            <li key={node.id}>
              <div
                className={`${css.row}${depth > 0 ? ` ${css.rowChild}` : ""}`}
              >
                {depth === 0 && kids.length > 0 ? (
                  <button
                    type="button"
                    className={css.expand}
                    aria-expanded={isOpen}
                    aria-label={`${isOpen ? "Collapse" : "Expand"} ${node.name}`}
                    disabled={searching}
                    onClick={() =>
                      setExpanded((prev) => {
                        const next = new Set(prev);
                        if (next.has(node.id)) next.delete(node.id);
                        else next.add(node.id);
                        return next;
                      })
                    }
                  >
                    <IconChevronDown
                      size={12}
                      className={`${css.expandIcon}${isOpen ? ` ${css.expandIconOpen}` : ""}`}
                      aria-hidden
                    />
                  </button>
                ) : (
                  <span className={css.expandSpacer} aria-hidden />
                )}

                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  disabled={Boolean(reason)}
                  className={`${css.option}${depth === 0 ? ` ${css.optionParent}` : ""}${
                    selected ? ` ${css.optionSelected}` : ""
                  }${onSelectedPath ? ` ${css.optionOnPath}` : ""}`}
                  onClick={() => pick(node.id)}
                >
                  <span className={css.optionName}>{node.name}</span>
                  {reason ? (
                    <span className={css.optionReason}>{reason}</span>
                  ) : (
                    note && <span className={css.optionMeta}>{note}</span>
                  )}
                  {selected && (
                    <IconCheck size={13} className={css.tick} aria-hidden />
                  )}
                </button>
              </div>
            </li>
          );
        })}

        {extra && (
          <li>
            <div className={`${css.row} ${css.rowExtra}`}>
              <span className={css.expandSpacer} aria-hidden />
              <button
                type="button"
                role="option"
                aria-selected={value === extra.value}
                className={`${css.option}${
                  value === extra.value ? ` ${css.optionSelected}` : ""
                }`}
                onClick={() => pick(extra.value)}
              >
                <span className={css.optionName}>{extra.label}</span>
                {extra.hint && (
                  <span className={css.optionMeta}>{extra.hint}</span>
                )}
                {value === extra.value && (
                  <IconCheck size={13} className={css.tick} aria-hidden />
                )}
              </button>
            </div>
          </li>
        )}
      </ul>
    </div>
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        className={`${css.trigger}${compact ? ` ${css.triggerCompact}` : ""}${
          open ? ` ${css.triggerOpen}` : ""
        }${selectedPath ? "" : ` ${css.triggerEmpty}`} ${className ?? ""}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <span className={css.triggerText}>{selectedPath ?? placeholder}</span>
        <IconChevronDown
          size={14}
          className={`${css.triggerChevron}${open ? ` ${css.triggerChevronOpen}` : ""}`}
          aria-hidden
        />
      </button>
      {menu && createPortal(menu, document.body)}
    </>
  );
}
