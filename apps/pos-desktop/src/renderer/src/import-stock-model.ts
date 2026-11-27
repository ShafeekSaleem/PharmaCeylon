import type { CounterWorkImportCategory, CounterWorkImportDetail } from "@pharmaceylon/shared";
import type { ImportPostInput } from "../../shared/ipc-contract";

/** Rows with no category post as their own selection: `categoryName: null`. */
export const categoryLabel = (name: string | null) => name ?? "No category";

/** A key for a category that tells "no category" apart from any name. */
export const categoryKey = (name: string | null) => (name === null ? "\u0000none" : `c:${name}`);

/** What "Post the rest" posts: every category not posted yet. */
export function restOf(detail: CounterWorkImportDetail) {
  const toPost = detail.categories.filter((c) => !c.posted);
  return {
    categories: toPost,
    rows: toPost.reduce((n, c) => n + c.rows, 0),
    batches: toPost.reduce((n, c) => n + c.batches, 0),
    units: toPost.reduce((n, c) => n + c.units, 0),
    posted: detail.categories.filter((c) => c.posted),
  };
}

/** The category to show: the one chosen if it is still there, else the first still to post. */
export function pickCategory(
  detail: CounterWorkImportDetail,
  key: string | null,
): CounterWorkImportCategory | null {
  const chosen = key === null ? undefined : detail.categories.find((c) => categoryKey(c.categoryName) === key);
  return chosen ?? detail.categories.find((c) => !c.posted) ?? detail.categories[0] ?? null;
}

/** "Antibiotics, Chronic care and Personal care". */
export function joinNames(categories: ReadonlyArray<CounterWorkImportCategory>): string {
  const names = categories.map((c) => categoryLabel(c.categoryName));
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export type ImportSelection = { selection: "all" } | { selection: "category"; categoryName: string | null };

/** The body the main process signs, pinned to the version shown. */
export function buildImportPost(detail: CounterWorkImportDetail, choice: ImportSelection): ImportPostInput {
  return {
    importId: detail.id,
    version: detail.stockVersion,
    selection: choice.selection,
    categoryName: choice.selection === "all" ? null : choice.categoryName,
  };
}
