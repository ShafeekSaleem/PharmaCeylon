"use client";

import { useMemo, useRef, useState } from "react";
import { IconPlus, IconSearch, IconX } from "@/components/icons";
import css from "../products.module.css";

type Option = {
  id: string;
  name: string;
  /** Present on commercial categories. Absent on tags, which are flat by nature. */
  parentCategoryId?: string | null;
};

export function RelationMultiSelect({
  label,
  options,
  selected,
  onChange,
  disabled,
  onCreateNew,
}: {
  label: string;
  options: Option[];
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  onCreateNew?: (name: string) => Promise<Option | null>;
}) {
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);

  /*
   * Categories are a two-level tree, so they are drawn as one — department in the parent's
   * weight, its categories indented under it. They used to be seventy-six flat, identical rows
   * in which "Other Medicines" and "Medicines" looked like siblings, which is the one thing the
   * list has to make clear. Tags carry no parent and fall through to the flat path unchanged.
   */
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = (o: Option) => !q || o.name.toLowerCase().includes(q);
    const hierarchical = options.some((o) => o.parentCategoryId);

    if (!hierarchical) {
      return options.filter(matches).map((opt) => ({ opt, depth: 0 }));
    }

    const childrenOf = new Map<string, Option[]>();
    for (const o of options) {
      if (!o.parentCategoryId) continue;
      const list = childrenOf.get(o.parentCategoryId) ?? [];
      list.push(o);
      childrenOf.set(o.parentCategoryId, list);
    }

    const out: Array<{ opt: Option; depth: number }> = [];
    for (const parent of options.filter((o) => !o.parentCategoryId)) {
      const children = (childrenOf.get(parent.id) ?? []).filter(matches);
      // A department with no matching children and no match of its own has nothing to show.
      if (!matches(parent) && children.length === 0) continue;
      out.push({ opt: parent, depth: 0 });
      for (const child of children) out.push({ opt: child, depth: 1 });
    }
    return out;
  }, [options, query]);

  const singular = label.toLowerCase().replace(/s$/, "");

  const toggle = (id: string) => {
    if (selected.includes(id)) {
      onChange(selected.filter((v) => v !== id));
    } else {
      onChange([...selected, id]);
    }
  };

  const openPrompt = () => {
    setPromptOpen(true);
    setNewName(query.trim());
    requestAnimationFrame(() => nameInputRef.current?.focus());
  };

  const closePrompt = () => {
    if (creating) return;
    setPromptOpen(false);
    setNewName("");
  };

  const handleCreate = async () => {
    if (!onCreateNew || !newName.trim()) return;
    setCreating(true);
    const created = await onCreateNew(newName.trim());
    setCreating(false);
    if (created) {
      if (!selected.includes(created.id)) {
        onChange([...selected, created.id]);
      }
      setNewName("");
      setPromptOpen(false);
      setQuery("");
    }
  };

  return (
    <div className={css.relationSelect}>
      <div className={css.relationSelectHead}>
        <span className={css.relationSelectLabel}>{label}</span>
      </div>

      <div className={css.relationToolbar}>
        <div className={css.relationSearchWrap}>
          <IconSearch size={14} className={css.relationSearchIcon} />
          <input
            type="search"
            className={css.relationSearch}
            placeholder={`Find ${label.toLowerCase()}…`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={disabled || creating}
          />
        </div>
        {onCreateNew && !disabled && (
          <button
            type="button"
            className={css.relationAddNewBtn}
            onClick={openPrompt}
            disabled={creating}
          >
            <IconPlus size={14} />
            Add new
          </button>
        )}
      </div>

      {promptOpen && onCreateNew && (
        <div className={css.relationCreatePrompt}>
          <label className={css.relationCreateLabel} htmlFor={`new-${singular}`}>
            New {singular} name
          </label>
          <div className={css.relationCreateRow}>
            <input
              id={`new-${singular}`}
              ref={nameInputRef}
              type="text"
              className={css.relationCreateInput}
              placeholder={`Enter ${singular} name…`}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              disabled={creating}
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
              disabled={creating || !newName.trim()}
            >
              Create
            </button>
            <button
              type="button"
              className={css.relationCreateCancel}
              onClick={closePrompt}
              disabled={creating}
              aria-label="Cancel"
              data-tooltip="Cancel"
            >
              <IconX size={14} />
            </button>
          </div>
        </div>
      )}

      {options.length === 0 ? (
        <div className={css.relationList}>
          <p className={css.relationEmpty}>
            None yet. {onCreateNew ? `Click Add new to create a ${singular}.` : "Open Manage all to add."}
          </p>
        </div>
      ) : (
        <div className={css.relationList} role="listbox" aria-label={label} aria-multiselectable>
          {rows.length === 0 ? (
            <p className={css.relationEmpty}>No matches.</p>
          ) : (
            rows.map(({ opt, depth }) => {
              const checked = selected.includes(opt.id);
              return (
                <label
                  key={opt.id}
                  className={`${css.relationOption} ${
                    depth === 0 ? css.relationOptionParent : css.relationOptionChild
                  } ${checked ? css.relationOptionSelected : ""}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(opt.id)}
                    disabled={disabled}
                  />
                  <span>{opt.name}</span>
                </label>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
