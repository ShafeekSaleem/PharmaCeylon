"use client";

import { useMemo, useState } from "react";
import { IconInfo } from "@/components/icons";
import type { ProductCategory } from "../../types";
import type {
  CategoryDecision,
  ImportCategoryChoices,
  ImportCategoryPlan,
  ImportCategoryPlanEntry,
} from "../types";
import css from "../import.module.css";

/** Rows shown before the "show all" toggle — a messy file can carry hundreds of values. */
const COLLAPSED_ROWS = 12;

type Props = {
  plan: ImportCategoryPlan;
  categories: ProductCategory[];
  choices: ImportCategoryChoices;
  onChange: (incoming: string, decision: CategoryDecision | null) => void;
};

/** `use:<id>` / `create:<parentId or empty>` / `skip` — one select, three kinds of answer. */
function encode(decision: CategoryDecision): string {
  if (decision.action === "use") return `use:${decision.categoryId}`;
  if (decision.action === "create") return `create:${decision.parentCategoryId ?? ""}`;
  return "skip";
}

function decode(value: string): CategoryDecision | null {
  if (value === "skip") return { action: "skip" };
  if (value.startsWith("use:")) return { action: "use", categoryId: value.slice(4) };
  if (value.startsWith("create:")) {
    const parent = value.slice(7);
    return { action: "create", parentCategoryId: parent || null };
  }
  return null;
}

/**
 * The Categories step of the import review.
 *
 * The importer used to read this column and throw it away, so the point of this block is that
 * nothing about category assignment happens invisibly: every distinct value in the file is
 * listed with where it will land and how many rows it affects, and every one of them can be
 * redirected before a single product is written.
 */
export function ImportCategoryBlock({ plan, categories, choices, onChange }: Props) {
  const [expanded, setExpanded] = useState(false);

  const departments = useMemo(
    () => categories.filter((c) => !c.parentCategoryId),
    [categories],
  );
  const childrenByParent = useMemo(() => {
    const map = new Map<string, ProductCategory[]>();
    for (const c of categories) {
      if (!c.parentCategoryId) continue;
      const list = map.get(c.parentCategoryId) ?? [];
      list.push(c);
      map.set(c.parentCategoryId, list);
    }
    return map;
  }, [categories]);

  const unmatched = plan.entries.filter((e) => e.status === "unmatched").length;
  const placedRows = plan.entries.reduce(
    (sum, e) => (effective(e, choices) ? sum + e.rowCount : sum),
    0,
  );

  const visible = expanded ? plan.entries : plan.entries.slice(0, COLLAPSED_ROWS);
  const hidden = plan.entries.length - visible.length;

  if (!plan.mapped && plan.entries.length === 0) {
    return (
      <>
        <h3 className={css.groupTitle}>Categories</h3>
        <p className={css.dim}>
          No Category column is mapped, so every new product will be filed automatically —
          medicines by their generic name where we recognise it, and anything else into
          Unclassified for you to place later.
        </p>
      </>
    );
  }

  return (
    <>
      <h3 className={css.groupTitle}>
        Categories
        {unmatched > 0 && (
          <span className={css.required}>
            {unmatched} to place
          </span>
        )}
      </h3>

      <p className={css.dim}>
        {placedRows > 0 ? (
          <>
            <strong>{placedRows.toLocaleString()}</strong> row
            {placedRows === 1 ? "" : "s"} will be filed from your Category column.{" "}
          </>
        ) : null}
        {plan.blankRows > 0 ? (
          <>
            <strong>{plan.blankRows.toLocaleString()}</strong> row
            {plan.blankRows === 1 ? " has" : "s have"} no category — those are sorted
            automatically, or land in Unclassified.
          </>
        ) : null}
      </p>

      <div className={css.categoryTableWrap}>
        <table className={css.categoryTable}>
          <thead>
            <tr>
              <th scope="col">In your file</th>
              <th scope="col" className={css.numCol}>
                Rows
              </th>
              <th scope="col">Files under</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((entry) => {
              const decision = choices[entry.incoming];
              const value = decision
                ? encode(decision)
                : entry.categoryId
                  ? `use:${entry.categoryId}`
                  : "skip";
              const isUnplaced = value === "skip";

              return (
                <tr key={entry.incoming}>
                  <td>
                    <span className={css.categoryIncoming}>{entry.incoming}</span>
                    {entry.status === "matched_synonym" && !decision && (
                      <span
                        className={css.miniChip}
                        title="Not one of your category names, but a name we recognise"
                      >
                        known name
                      </span>
                    )}
                    {entry.willEnable && !isUnplaced && (
                      <span className={css.categoryHint}>
                        turns this department back on
                      </span>
                    )}
                  </td>
                  <td className={css.numCol}>{entry.rowCount.toLocaleString()}</td>
                  <td>
                    <select
                      className={css.mapSelect}
                      aria-label={`Category for ${entry.incoming}`}
                      value={value}
                      onChange={(e) => {
                        const next = decode(e.target.value);
                        // Clearing back to the automatic answer keeps the payload to real
                        // overrides only.
                        const isAuto =
                          next?.action === "use" && next.categoryId === entry.categoryId;
                        onChange(entry.incoming, isAuto ? null : next);
                      }}
                    >
                      <option value="skip">Sort it automatically</option>
                      {departments.map((dept) => (
                        <optgroup key={dept.id} label={dept.name}>
                          <option value={`use:${dept.id}`}>{dept.name} (department)</option>
                          {(childrenByParent.get(dept.id) ?? []).map((child) => (
                            <option key={child.id} value={`use:${child.id}`}>
                              {child.name}
                            </option>
                          ))}
                          <option value={`create:${dept.id}`}>
                            ＋ New category under {dept.name}
                          </option>
                        </optgroup>
                      ))}
                      <optgroup label="Something else">
                        <option value="create:">
                          ＋ New department called “{entry.incoming}”
                        </option>
                      </optgroup>
                    </select>
                    {isUnplaced && (
                      <span className={css.categoryHint}>
                        we don&apos;t recognise this name
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {hidden > 0 && (
        <button
          type="button"
          className={css.secondaryBtn}
          onClick={() => setExpanded(true)}
        >
          Show {hidden.toLocaleString()} more
        </button>
      )}

      <p className={css.categoryFootnote}>
        <IconInfo size={14} />
        Only products this import creates are filed. Anything matched to a product you already
        have keeps the category it already has.
      </p>
    </>
  );
}

/** The category a row will actually land in, once the user's override is applied. */
function effective(
  entry: ImportCategoryPlanEntry,
  choices: ImportCategoryChoices,
): string | null {
  const decision = choices[entry.incoming];
  if (!decision) return entry.categoryId;
  if (decision.action === "skip") return null;
  if (decision.action === "use") return decision.categoryId;
  return "new";
}
