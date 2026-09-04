"use client";

import { useCallback, useState } from "react";
import { apiJson } from "@/lib/auth-client";
import type {
  BulkProductAction,
  BulkProductPreview,
  BulkProductResult,
} from "../types";

export type BulkTarget =
  | { kind: "ids"; productIds: string[] }
  /** "Select all N matching" — the server resolves the filter so the client never has to
   *  page through thousands of ids just to un-range an over-broad import. */
  | { kind: "filter"; params: URLSearchParams };

const ACTION_PAST_TENSE: Record<BulkProductAction, string> = {
  range: "added to your products",
  unrange: "moved to the reference catalog",
  activate: "activated",
  deactivate: "deactivated",
  set_category: "filed under a new category",
  clear_category: "moved back to Unclassified",
  add_tags: "tagged",
  remove_tags: "untagged",
};

/** The category or tags an action targets, alongside its selection. */
export type BulkExtras = { categoryId?: string; tagIds?: string[] };

function buildBody(
  action: BulkProductAction,
  target: BulkTarget,
): Record<string, unknown> {
  return target.kind === "ids"
    ? { action, productIds: target.productIds }
    : { action, filter: filterFromParams(target.params) };
}

function filterFromParams(params: URLSearchParams): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  for (const [key, value] of params.entries()) {
    // Paging and sort describe the view, not the selection.
    if (key === "skip" || key === "take" || key === "sortBy" || key === "sortDir") continue;
    if (key === "lowStock" || key === "requiresPrescription") {
      filter[key] = value === "true";
      continue;
    }
    filter[key] = value;
  }
  return filter;
}

/**
 * Range / un-range / activate / deactivate the selected products. One request per action, so
 * a 2,000-row correction is a single audited operation rather than 2,000 PATCHes.
 */
export function useProductBulkActions(onDone: () => void) {
  const [running, setRunning] = useState<BulkProductAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const run = useCallback(
    async (action: BulkProductAction, target: BulkTarget, extras: BulkExtras = {}) => {
      setRunning(action);
      setError(null);
      setNotice(null);
      try {
        const body = { ...buildBody(action, target), ...extras };
        const result = await apiJson<BulkProductResult>("/products/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const noun = result.updated === 1 ? "product" : "products";
        setNotice(
          result.updated === 0
            ? "Nothing to change — those products were already in that state."
            : `${result.updated.toLocaleString()} ${noun} ${ACTION_PAST_TENSE[action]}.`,
        );
        onDone();
        return result;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Bulk action failed");
        return null;
      } finally {
        setRunning(null);
      }
    },
    [onDone],
  );

  /**
   * What the action would do, without doing it. Feeds the confirmation dialog, so the counts
   * shown and the counts applied come from the same server-side selection resolution rather
   * than the client guessing from what happens to be on the current page.
   */
  const preview = useCallback(
    async (
      action: BulkProductAction,
      target: BulkTarget,
      extras: BulkExtras = {},
    ): Promise<BulkProductPreview | null> => {
      try {
        return await apiJson<BulkProductPreview>("/products/bulk/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...buildBody(action, target), ...extras }),
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't check that action");
        return null;
      }
    },
    [],
  );

  const dismissNotice = useCallback(() => setNotice(null), []);
  const dismissError = useCallback(() => setError(null), []);

  return { run, preview, running, error, notice, dismissNotice, dismissError };
}
