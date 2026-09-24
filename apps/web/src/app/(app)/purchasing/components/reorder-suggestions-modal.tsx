"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert } from "@/components/alert";
import { IconPackage, IconTruck } from "@/components/icons";
import { Modal, ModalButton, ModalFooter } from "@/components/ui";
import { apiJson } from "@/lib/auth-client";
import { useAuth } from "@/lib/use-auth";
import css from "../purchasing.module.css";
import type { ReorderSuggestionItem, ReorderSuggestions } from "../types";
import { formatMoney } from "../utils";

type Props = {
  open: boolean;
  canViewCost: boolean;
  onClose: () => void;
  onCreated: () => void;
};

/**
 * "What to order", grouped by the supplier who sells it cheapest.
 *
 * The recommendation people had before was a flat list that ignored open orders, so acting on
 * it meant checking every line against the orders screen first. Here each supplier is one draft
 * purchase order away, and every row says what is already on its way.
 */
export function ReorderSuggestionsModal({ open, canViewCost, onClose, onCreated }: Props) {
  const { branchId } = useAuth();
  const [data, setData] = useState<ReorderSuggestions | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creatingFor, setCreatingFor] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    if (!open || !branchId) return;
    setLoading(true);
    setError(null);
    try {
      setData(await apiJson<ReorderSuggestions>("/purchasing/reorder-suggestions"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to work out what to order");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [open, branchId]);

  useEffect(() => {
    if (open) {
      setSkipped(new Set());
      void load();
    }
  }, [open, load]);

  const toggleSkip = (productId: string) => {
    setSkipped((prev) => {
      const next = new Set(prev);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      return next;
    });
  };

  const createDraft = async (supplierId: string, items: ReorderSuggestionItem[]) => {
    const lines = items.filter((item) => !skipped.has(item.productId));
    if (lines.length === 0) return;
    setCreatingFor(supplierId);
    setError(null);
    try {
      await apiJson("/purchasing/purchase-orders", {
        method: "POST",
        body: JSON.stringify({
          supplierId,
          items: lines.map((item) => ({
            productId: item.productId,
            // Packs where the product has one, so the draft matches how it is bought.
            ...(item.suggestedPacks
              ? { orderedPacks: item.suggestedPacks, unitsPerPack: item.unitsPerPack }
              : { orderedQty: item.suggestedQty }),
            ...(item.unitCost ? { unitCost: item.unitCost } : {}),
          })),
        }),
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create the draft order");
    } finally {
      setCreatingFor(null);
    }
  };

  const totalLines = useMemo(
    () =>
      (data?.suppliers ?? []).reduce((sum, group) => sum + group.items.length, 0) +
      (data?.unassigned.length ?? 0),
    [data],
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="What to order"
      description="Products at or below their reorder level, after counting available stock and everything already on order."
      size="lg"
      footer={
        <ModalFooter>
          <ModalButton onClick={onClose}>Close</ModalButton>
        </ModalFooter>
      }
    >
      {error && <Alert variant="error">{error}</Alert>}

      {loading && <p className={css.muted}>Working out what is short…</p>}

      {!loading && data && totalLines === 0 && (
        <div className={css.emptyState}>
          <IconPackage size={22} />
          <p>Nothing is below its reorder level once open orders are counted.</p>
        </div>
      )}

      {!loading &&
        data?.suppliers.map((group) => {
          const included = group.items.filter((item) => !skipped.has(item.productId));
          return (
            <section key={group.supplier.id} className={css.suggestGroup}>
              <header className={css.suggestHeader}>
                <div>
                  <h3 className={css.suggestSupplier}>
                    <IconTruck size={15} />
                    {group.supplier.name}
                  </h3>
                  <p className={css.muted}>
                    {included.length} of {group.items.length} product
                    {group.items.length === 1 ? "" : "s"}
                    {group.supplier.leadTimeDays
                      ? ` · usually ${group.supplier.leadTimeDays} day${group.supplier.leadTimeDays === 1 ? "" : "s"} to arrive`
                      : ""}
                    {canViewCost && group.estimatedValue
                      ? ` · about ${formatMoney(group.estimatedValue)}`
                      : ""}
                  </p>
                </div>
                <ModalButton
                  variant="primary"
                  disabled={included.length === 0 || creatingFor !== null}
                  onClick={() => void createDraft(group.supplier.id, group.items)}
                >
                  {creatingFor === group.supplier.id ? "Creating…" : "Create draft order"}
                </ModalButton>
              </header>

              <div className={css.tableScroll}>
                <table className={css.suggestTable}>
                  <thead>
                    <tr>
                      <th scope="col">Product</th>
                      <th scope="col">Available</th>
                      <th scope="col">On order</th>
                      <th scope="col">Reorder at</th>
                      <th scope="col">Order</th>
                      <th scope="col" aria-label="Include" />
                    </tr>
                  </thead>
                  <tbody>
                    {group.items.map((item) => {
                      const off = skipped.has(item.productId);
                      return (
                        <tr key={item.productId} className={off ? css.rowMuted : undefined}>
                          <td>
                            <div className={css.cellStrong}>{item.name}</div>
                            <div className={css.muted}>
                              {item.sku}
                              {item.supplierSku ? ` · their code ${item.supplierSku}` : ""}
                            </div>
                          </td>
                          <td>{item.available}</td>
                          <td>
                            {item.onOrderQty > 0 ? item.onOrderQty : "—"}
                            {item.plannedQty > 0 ? (
                              <div className={css.muted}>{item.plannedQty} in draft</div>
                            ) : null}
                          </td>
                          <td>{item.reorderLevel}</td>
                          <td>
                            <div className={css.cellStrong}>
                              {item.suggestedPacks
                                ? `${item.suggestedPacks} × ${item.packLabel ?? `pack of ${item.unitsPerPack}`}`
                                : `${item.suggestedQty} units`}
                            </div>
                            {item.suggestedPacks ? (
                              <div className={css.muted}>{item.suggestedQty} units</div>
                            ) : null}
                          </td>
                          <td>
                            <button
                              type="button"
                              className={css.actionBtn}
                              onClick={() => toggleSkip(item.productId)}
                            >
                              {off ? "Include" : "Skip"}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          );
        })}

      {!loading && data && data.unassigned.length > 0 && (
        <section className={css.suggestGroup}>
          <header className={css.suggestHeader}>
            <div>
              <h3 className={css.suggestSupplier}>No supplier price on file</h3>
              <p className={css.muted}>
                These are short too, but no active supplier lists them — add a price on the
                supplier to have them grouped here.
              </p>
            </div>
          </header>
          <ul className={css.plainList}>
            {data.unassigned.map((item) => (
              <li key={item.productId}>
                <span className={css.cellStrong}>{item.name}</span>{" "}
                <span className={css.muted}>
                  {item.available} available · reorder at {item.reorderLevel} · order{" "}
                  {item.suggestedQty}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </Modal>
  );
}
