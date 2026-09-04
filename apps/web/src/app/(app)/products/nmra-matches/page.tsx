"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Alert } from "@/components/alert";
import { IconCheck, IconRefresh } from "@/components/icons";
import { ActionButton, PageHeader } from "@/components/ui";
import { usePageChrome } from "@/lib/page-chrome-context";
import { usePermissions } from "@/lib/permissions";
import {
  bulkApplyNmraLinks,
  fetchNmraLinkQueue,
  type NmraLinkEvidence,
  type NmraLinkQueueItem,
} from "../api/nmra-link";
import { CatalogTabs } from "../components/catalog-tabs";
import { ProductNmraLinkModal } from "../components/product-nmra-link-modal";
import css from "./nmra-matches.module.css";

const PAGE_SIZE = 50;

const EVIDENCE_LABELS: Record<NmraLinkEvidence, string> = {
  barcode: "Matched by barcode",
  registration: "Matched by registration no.",
  name: "Matched by exact name",
  normalized: "Matched by similar name",
  fuzzy: "Matched by generic + strength + form",
  inn_head: "Matched by substance name",
};

/**
 * The bulk "find register matches" worklist. Closes F5's other half — the single-product
 * card handles one at a time, this is for working through the whole unlinked range: grouped
 * by how strong the evidence is, with a bulk-accept per group. Any pair that would change a
 * compliance flag on evidence weaker than an exact identifier is held out by the API itself
 * rather than trusted here — see `rankedCandidateNeedsComplianceConfirmation`.
 */
export default function NmraMatchesPage() {
  const { permissionKeys } = usePermissions();
  const canWrite = permissionKeys.includes("products.manage");
  const { setLastSegmentLabel } = usePageChrome();

  const [items, setItems] = useState<NmraLinkQueueItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reviewProductId, setReviewProductId] = useState<string | null>(null);

  useEffect(() => {
    setLastSegmentLabel("Register matches");
    return () => setLastSegmentLabel(null);
  }, [setLastSegmentLabel]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await fetchNmraLinkQueue(PAGE_SIZE);
      setItems(page.items);
      setTotal(page.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load the worklist");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Grouped by the strongest evidence its top candidate offers. */
  const groups = useMemo(() => {
    const byEvidence = new Map<
      NmraLinkEvidence | "none",
      { items: NmraLinkQueueItem[] }
    >();
    for (const item of items) {
      const key = item.candidates[0]?.evidence ?? "none";
      const entry = byEvidence.get(key) ?? { items: [] };
      entry.items.push(item);
      byEvidence.set(key, entry);
    }
    const order: Array<NmraLinkEvidence | "none"> = [
      "barcode",
      "registration",
      "name",
      "normalized",
      "fuzzy",
      "inn_head",
      "none",
    ];
    return order
      .filter((key) => byEvidence.has(key))
      .map((key) => ({ key, ...byEvidence.get(key)! }));
  }, [items]);

  const withCandidates = items.filter((i) => i.candidates.length > 0);

  async function acceptGroup(groupItems: NmraLinkQueueItem[]) {
    const links = groupItems
      .filter((i) => i.candidates.length > 0)
      .map((i) => ({ productId: i.product.id, referenceProductId: i.candidates[0].product.id }));
    if (links.length === 0) return;
    await runBulkLink(links);
  }

  async function acceptAllTopCandidates() {
    const links = withCandidates.map((i) => ({
      productId: i.product.id,
      referenceProductId: i.candidates[0].product.id,
    }));
    await runBulkLink(links);
  }

  async function runBulkLink(links: Array<{ productId: string; referenceProductId: string }>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await bulkApplyNmraLinks(links);
      const parts = [`${result.linked.length.toLocaleString()} linked`];
      if (result.held.length > 0) {
        parts.push(`${result.held.length.toLocaleString()} need individual review`);
      }
      if (result.failed.length > 0) {
        parts.push(`${result.failed.length.toLocaleString()} failed`);
      }
      setNotice(parts.join(" · "));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't apply those links");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={css.page}>
      <PageHeader
        subtitleOnly
        floatingActions
        description="Products that could pick up a registration number and schedule from the NMRA register."
        actions={
          canWrite && withCandidates.length > 0 ? (
            <ActionButton
              icon={<IconCheck size={16} />}
              onClick={() => void acceptAllTopCandidates()}
              disabled={busy}
            >
              Accept {withCandidates.length.toLocaleString()} top match
              {withCandidates.length === 1 ? "" : "es"}
            </ActionButton>
          ) : undefined
        }
      />

      <CatalogTabs active="nmra-matches" />

      {error && <Alert variant="error" onClose={() => setError(null)}>{error}</Alert>}
      {notice && <Alert variant="success" onClose={() => setNotice(null)}>{notice}</Alert>}

      {loading ? (
        <div className={css.card}>
          <p className={css.empty}>Loading…</p>
        </div>
      ) : items.length === 0 ? (
        <div className={css.card}>
          <p className={css.done}>
            <IconRefresh size={18} />
            Nothing left to match against the register.
          </p>
          <p className={css.empty}>
            Head back to <Link href="/products" className={css.link}>Products</Link>.
          </p>
        </div>
      ) : (
        <>
          {total > items.length && (
            <p className={css.pageNote}>
              Showing the first {items.length.toLocaleString()} of{" "}
              {total.toLocaleString()}.
            </p>
          )}

          {groups.map((group) => (
            <section key={group.key} className={css.card}>
              <header className={css.groupHead}>
                <div className={css.groupTitleWrap}>
                  <h2 className={css.groupTitle}>
                    {group.key === "none" ? "No register candidate found" : EVIDENCE_LABELS[group.key]}
                  </h2>
                  <p className={css.groupCount}>
                    {group.items.length.toLocaleString()} product
                    {group.items.length === 1 ? "" : "s"}
                  </p>
                </div>
                {canWrite && group.key !== "none" && (
                  <ActionButton
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void acceptGroup(group.items)}
                  >
                    Accept all {group.items.length.toLocaleString()}
                  </ActionButton>
                )}
              </header>

              <ul className={css.rows}>
                {group.items.map((item) => {
                  const top = item.candidates[0];
                  return (
                    <li key={item.product.id} className={css.row}>
                      <div className={css.rowMain}>
                        <span className={css.rowName}>
                          {item.product.name}
                          {item.product.brandName ? ` — ${item.product.brandName}` : ""}
                        </span>
                        {top ? (
                          <span className={css.rowCandidate}>
                            → {top.product.name}
                            {top.product.brandName ? ` — ${top.product.brandName}` : ""}
                            {top.product.registrationNo ? ` · Reg. ${top.product.registrationNo}` : ""}
                          </span>
                        ) : (
                          <span className={css.rowMeta}>No candidate found</span>
                        )}
                      </div>
                      {top?.needsComplianceConfirmation && (
                        <span className={css.evidenceChip}>Compliance change</span>
                      )}
                      {canWrite && (
                        <ActionButton
                          variant="secondary"
                          onClick={() => setReviewProductId(item.product.id)}
                        >
                          Review
                        </ActionButton>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </>
      )}

      <ProductNmraLinkModal
        open={reviewProductId !== null}
        productId={reviewProductId ?? ""}
        onClose={() => setReviewProductId(null)}
        onLinked={() => {
          setReviewProductId(null);
          void load();
        }}
      />
    </div>
  );
}
