"use client";

import { useRef, useState } from "react";
import { Alert } from "@/components/alert";
import { ActionButton, ApprovalEvidencePanel, CounterHandoff, StatusBadge } from "@/components/ui";
import { formatMoney } from "@/lib/money";
import type { CaseBatch, ResolutionKind, SettlementLink, StockCaseDetail, StockCasePlan } from "./types";
import css from "./stock-cases.module.css";

export const REVIEW_PERMISSION = "inventory.resolve_stock_cases";

const KIND_LABELS: Record<ResolutionKind, { title: string; help: string }> = {
  post_now: {
    title: "Post the sale now",
    help: "Stock now covers every batch (for example after a delivery). The counter posts the sale's units as they are.",
  },
  count_and_correct: {
    title: "Count and correct",
    help: "Someone at the counter counts each batch. The batch is corrected once to that count, then the sale posts — units the count already reflects are never taken off twice.",
  },
  link_existing_settlement: {
    title: "Link an existing settlement",
    help: "A stocktake or write-off after the sale already took these units off. It is linked once instead of posting the sale again.",
  },
};

const REASON_LABELS: Record<CaseBatch["reason"], string> = {
  shortfall: "Short",
  counted_after_sale: "Counted after the sale",
  batch_under_review: "Batch already under review",
  sale_pending: "Waits with the rest of the sale",
  entry_reviewed: "Recorded after a manager reviewed the refused offline sale",
};

export const PLAN_LABELS: Record<StockCasePlan["status"], string> = {
  prepared: "Needs approval",
  approved: "Approved",
  executed: "Resolved",
  cancelled: "Cancelled",
};

export const when = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "—";
const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
const name = (p: { name: string | null } | null) => p?.name ?? "—";
const MOVEMENT_LABELS: Record<string, string> = {
  sale_out: "Sale",
  sale_void_in: "Sale voided",
  sale_refund_in: "Refund",
  purchase_in: "Received",
  transfer_in: "Transfer in",
  transfer_out: "Transfer out",
  adjustment_in: "Adjustment in",
  adjustment_out: "Write-off / correction",
  stocktake_in: "Stocktake gain",
  stocktake_out: "Stocktake loss",
  quarantine_hold: "Quarantine",
  quarantine_release: "Released from quarantine",
  supplier_return_out: "Returned to supplier",
  customer_return_in: "Customer return",
  opening_stock: "Opening stock",
};

export function CaseDetail({
  detail,
  busy,
  userId,
  canSelfApprove,
  onPrepare,
  onApprove,
  onCancel,
}: {
  detail: StockCaseDetail;
  busy: boolean;
  userId: string | null;
  canSelfApprove: boolean;
  onPrepare: (body: { kind: ResolutionKind; links?: SettlementLink[]; note?: string }) => Promise<boolean>;
  onApprove: (plan: StockCasePlan, approvalId: string) => Promise<boolean>;
  onCancel: (plan: StockCasePlan) => Promise<boolean>;
}) {
  const openPlan = detail.plans.find((p) => p.status === "prepared" || p.status === "approved") ?? null;
  const executed = detail.plans.find((p) => p.status === "executed") ?? null;
  // One approval ID per displayed content, so a retried click can't approve twice.
  const approvalIds = useRef<Record<string, string>>({});
  const approve = (plan: StockCasePlan) => {
    const slot = `${plan.id}:${plan.approvalReview?.expectedDigest}`;
    approvalIds.current[slot] ??= crypto.randomUUID();
    return onApprove(plan, approvalIds.current[slot]);
  };

  return (
    <div className={css.form}>
      <section className={css.card} aria-label="Offline sale">
        <h2 className={css.cardTitle}>
          Sale {detail.sale.invoiceNo}{" "}
          <StatusBadge
            status={detail.sale.stockPosting === "posted" ? "posted" : "pending"}
            label={detail.sale.stockPosting === "posted" ? "Stock posted" : "Stock pending"}
          />
        </h2>
        <dl className={css.facts}>
          <div>
            <dt>Sold offline</dt>
            <dd>{when(detail.offline.occurredAt)}</dd>
          </div>
          <div>
            <dt>Sold by</dt>
            <dd>{name(detail.sale.soldBy)}</dd>
          </div>
          <div>
            <dt>Counter</dt>
            <dd>
              {detail.offline.counter ?? "—"}
              {detail.offline.sequence ? ` · entry ${detail.offline.sequence}` : ""}
            </dd>
          </div>
          <div>
            <dt>Synced</dt>
            <dd>
              {when(detail.offline.syncedAt)} by {name(detail.offline.uploadedBy)}
            </dd>
          </div>
          <div>
            <dt>Total</dt>
            <dd>{formatMoney(detail.sale.grandTotal)}</dd>
          </div>
          <div>
            <dt>Paid</dt>
            <dd>{detail.sale.payments.map((p) => `${p.method} ${formatMoney(p.amount)}`).join(", ") || "—"}</dd>
          </div>
          <div>
            <dt>Snapshot</dt>
            <dd>
              v{detail.snapshot.version} · {when(detail.snapshot.generatedAt)}
            </dd>
          </div>
        </dl>
        <table className={css.table} aria-label="Receipt">
          <thead>
            <tr>
              <th>Item</th>
              <th>Batch</th>
              <th className={css.num}>Qty</th>
              <th className={css.num}>Price</th>
              <th className={css.num}>Total</th>
            </tr>
          </thead>
          <tbody>
            {detail.sale.items.map((item) => (
              <tr key={`${item.batchId}:${item.productId}`}>
                <td>{item.productName}</td>
                <td>{item.batchNo}</td>
                <td className={css.num}>{item.qty}</td>
                <td className={css.num}>{formatMoney(item.unitPrice)}</td>
                <td className={css.num}>{formatMoney(item.lineTotal)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {detail.batches.map((batch) => (
        <BatchEvidence key={batch.batchId} batch={batch} />
      ))}

      <section className={css.card} aria-label="Resolution">
        <h2 className={css.cardTitle}>Resolution</h2>
        {executed ? (
          <Resolved detail={detail} plan={executed} />
        ) : openPlan ? (
          <OpenPlan
            plan={openPlan}
            busy={busy}
            canApprove={openPlan.requester?.id !== userId || canSelfApprove}
            onApprove={() => void approve(openPlan)}
            onCancel={() => void onCancel(openPlan)}
          />
        ) : detail.status === "open" ? (
          <PlanForm detail={detail} busy={busy} onPrepare={onPrepare} />
        ) : null}
      </section>
    </div>
  );
}

function BatchEvidence({ batch }: { batch: CaseBatch }) {
  return (
    <section className={css.card} aria-label={`Batch ${batch.batchNo ?? batch.batchId}`}>
      <h3 className={css.cardTitle}>
        {batch.productName} · batch {batch.batchNo}{" "}
        {batch.blocked ? <StatusBadge status="blocked" label="Paused for sale" /> : null}
      </h3>
      <dl className={css.facts}>
        <div>
          <dt>Sold offline</dt>
          <dd>{batch.soldQuantity}</dd>
        </div>
        <div>
          <dt>Available at sync</dt>
          <dd>{batch.availableQuantityAtSync}</dd>
        </div>
        <div>
          <dt>Why it waits</dt>
          <dd className={batch.reason === "shortfall" ? css.warn : undefined}>
            {REASON_LABELS[batch.reason]}
            {batch.shortfallQuantity > 0 ? ` (${batch.shortfallQuantity} short)` : ""}
          </dd>
        </div>
        <div>
          <dt>Pending on this batch</dt>
          <dd>
            {batch.pending.total}
            {batch.pending.otherOpenCases.length
              ? ` (${batch.pending.otherOpenCases.map((o) => `${o.soldQuantity} from ${o.invoiceNo}`).join(", ")} too)`
              : ""}
          </dd>
        </div>
        <div>
          <dt>On hand now</dt>
          <dd>
            {batch.stock.onHand}
            {batch.stock.quarantined ? ` · ${batch.stock.quarantined} held` : ""}
            {batch.stock.reserved ? ` · ${batch.stock.reserved} reserved` : ""}
          </dd>
        </div>
      </dl>
      {batch.timelineTruncated ? (
        <p className={css.sub}>Showing the latest {batch.timeline.length} movements since the snapshot; earlier ones are in Movements.</p>
      ) : null}
      <table className={css.table} aria-label={`Since the snapshot: batch ${batch.batchNo ?? ""}`}>
        <thead>
          <tr>
            <th>When</th>
            <th>What</th>
            <th>Reference</th>
            <th>By</th>
            <th className={css.num}>Units</th>
          </tr>
        </thead>
        <tbody>
          {batch.timeline.map((e) => (
            <tr key={e.id}>
              <td>{when(e.occurredAt)}</td>
              <td>
                {MOVEMENT_LABELS[e.movementType] ?? e.movementType}
                {e.bucket === "quarantine" ? " (held)" : ""}
              </td>
              <td>{e.reference ?? e.reason ?? "—"}</td>
              <td>{name(e.actor)}</td>
              <td className={css.num}>{signed(e.qtyDelta)}</td>
            </tr>
          ))}
          {!batch.timeline.length ? (
            <tr>
              <td colSpan={5} className={css.sub}>
                Nothing has moved on this batch since the snapshot.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
      {batch.stocktakes.length ? (
        <p className={css.sub}>
          Counted:{" "}
          {batch.stocktakes
            .map((s) => `${s.stocktakeNumber} counted ${s.countedQty ?? "—"} at ${when(s.countedAt)} by ${name(s.countedBy)}${s.settlesThisSale ? " (after the sale)" : ""}`)
            .join("; ")}
        </p>
      ) : null}
    </section>
  );
}

/** Choose the kind; for a link, choose what accounted for each batch. Nothing moves yet. */
function PlanForm({
  detail,
  busy,
  onPrepare,
}: {
  detail: StockCaseDetail;
  busy: boolean;
  onPrepare: (body: { kind: ResolutionKind; links?: SettlementLink[]; note?: string }) => Promise<boolean>;
}) {
  const [kind, setKind] = useState<ResolutionKind>("count_and_correct");
  const [note, setNote] = useState("");
  const [choice, setChoice] = useState<Record<string, string>>({});
  const coversNow = detail.batches.every((b) => b.stock.available >= b.soldQuantity);
  // A posted count after the sale already took its units off; posting them again would double them.
  const countedAfterSale = detail.batches.some((b) => b.stocktakes.some((s) => s.settlesThisSale));
  const options = (batch: CaseBatch) => [
    ...batch.stocktakes
      .filter((s) => s.settlesThisSale)
      .map((s) => ({ value: `stocktake:${s.stocktakeId}`, label: `Stocktake ${s.stocktakeNumber} (counted ${s.countedQty})` })),
    ...batch.movementCandidates
      .filter((m) => m.remaining >= batch.soldQuantity)
      .map((m) => ({ value: `movement:${m.ledgerEntryId}`, label: `Write-off of ${m.qty} on ${when(m.occurredAt)}${m.reason ? ` · ${m.reason}` : ""}` })),
  ];
  const links = (): SettlementLink[] | null => {
    const out: SettlementLink[] = [];
    for (const batch of detail.batches) {
      const picked = choice[batch.batchId] ?? options(batch)[0]?.value;
      if (!picked) return null;
      const [source, id] = picked.split(":") as [string, string];
      out.push(source === "stocktake"
        ? { batchId: batch.batchId, source: "stocktake", stocktakeId: id }
        : { batchId: batch.batchId, source: "movements", ledgerEntryIds: [id] });
    }
    return out;
  };
  const linkable = links() !== null;

  return (
    <div className={css.form}>
      <fieldset className={css.kinds}>
        <legend>How should this case be resolved?</legend>
        {(Object.keys(KIND_LABELS) as ResolutionKind[]).map((k) => (
          <label key={k} className={css.kind}>
            <input
              type="radio"
              name="kind"
              value={k}
              checked={kind === k}
              onChange={() => setKind(k)}
              disabled={busy || (k === "link_existing_settlement" && !linkable) || (k === "post_now" && countedAfterSale)}
            />
            <span>
              <strong>{KIND_LABELS[k].title}</strong>
              <br />
              <span className={css.sub}>
                {KIND_LABELS[k].help}
                {k === "post_now" && countedAfterSale
                  ? " A stocktake counted a batch after the sale, so its units are already off. Link it or count instead."
                  : k === "post_now" && !coversNow
                    ? " Stock does not cover the sale right now."
                    : ""}
                {k === "link_existing_settlement" && !linkable ? " Nothing after the sale has accounted for every batch." : ""}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      {kind === "link_existing_settlement"
        ? detail.batches.map((batch) => (
            <label key={batch.batchId} className={css.kind}>
              <span>Batch {batch.batchNo}</span>
              <select
                aria-label={`What accounted for batch ${batch.batchNo}`}
                value={choice[batch.batchId] ?? options(batch)[0]?.value ?? ""}
                onChange={(e) => setChoice((prev) => ({ ...prev, [batch.batchId]: e.target.value }))}
                disabled={busy}
              >
                {options(batch).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          ))
        : null}
      <label className={css.kind}>
        <span>Note</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} disabled={busy} aria-label="Note" />
      </label>
      <div className={css.actions}>
        <ActionButton
          disabled={busy}
          onClick={() =>
            void onPrepare({
              kind,
              ...(kind === "link_existing_settlement" ? { links: links() ?? [] } : {}),
              ...(note.trim() ? { note: note.trim() } : {}),
            })
          }
        >
          Prepare plan
        </ActionButton>
      </div>
    </div>
  );
}

function OpenPlan({
  plan,
  busy,
  canApprove,
  onApprove,
  onCancel,
}: {
  plan: StockCasePlan;
  busy: boolean;
  canApprove: boolean;
  onApprove: () => void;
  onCancel: () => void;
}) {
  const needsApproval = plan.status === "prepared" || plan.approvalState !== "matches";
  return (
    <>
      <p>
        <strong>{KIND_LABELS[plan.kind].title}</strong>
        {plan.note ? <span className={css.sub}> · {plan.note}</span> : null}
      </p>
      {plan.approvalState === "changed" ? (
        <Alert variant="warning">
          Changed since approval: another offline sale now waits on one of these batches. Review the
          case again and approve it before the counter can resolve it.
        </Alert>
      ) : null}
      <ApprovalEvidencePanel
        title="Plan approval"
        approvedVersion={plan.executionApprovalId ? plan.approvalVersion : null}
        currentVersion={plan.approvalVersion}
        status={plan.status}
        statusLabel={
          plan.readyAtCounter
            ? "Waiting at the counter"
            : plan.approvalState === "revoked"
              ? "Needs fresh approval"
              : plan.approvalState === "changed"
                ? "Changed since approval"
                : "Needs approval"
        }
        requester={plan.requester ? { name: name(plan.requester), at: plan.requestedAt } : null}
        approver={plan.approver && plan.approvalState !== "none" ? { name: name(plan.approver), at: plan.approvedAt } : null}
        executor={null}
      />
      {plan.readyAtCounter ? (
        <CounterHandoff
          branchName="this branch"
          action={plan.kind === "count_and_correct" ? "Count the batches and settle the sale" : "Settle the sale's stock"}
          whoCan={["Inventory clerk", "Manager", "Owner"]}
        />
      ) : null}
      <div className={css.actions}>
        <ActionButton variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel plan
        </ActionButton>
        {needsApproval && canApprove && plan.approvalReview ? (
          <ActionButton onClick={onApprove} disabled={busy}>
            Approve plan
          </ActionButton>
        ) : null}
      </div>
    </>
  );
}

function Resolved({ detail, plan }: { detail: StockCaseDetail; plan: StockCasePlan }) {
  return (
    <>
      <ApprovalEvidencePanel
        title="Resolution"
        approvedVersion={plan.approvalVersion}
        currentVersion={plan.approvalVersion}
        status="completed"
        statusLabel={`Resolved: ${KIND_LABELS[plan.kind].title.toLowerCase()}`}
        requester={{ name: name(plan.requester), at: plan.requestedAt }}
        approver={{ name: name(plan.approver), at: plan.approvedAt }}
        executor={{ name: name(plan.executor), at: plan.executedAt }}
      />
      <table className={css.table} aria-label="How each batch was settled">
        <thead>
          <tr>
            <th>Batch</th>
            <th>Settled by</th>
            <th className={css.num}>Counted</th>
            <th className={css.num}>Correction</th>
            <th className={css.num}>Posted</th>
          </tr>
        </thead>
        <tbody>
          {detail.settlements.map((s) => (
            <tr key={s.batchId}>
              <td>{detail.batches.find((b) => b.batchId === s.batchId)?.batchNo ?? s.batchId}</td>
              <td>{s.method === "counted" ? `Count by ${name(s.countedBy)}` : s.method === "linked" ? "Linked settlement" : "Posted"}</td>
              <td className={css.num}>{s.countedQuantity ?? "—"}</td>
              <td className={css.num}>{signed(s.correctionQuantity)}</td>
              <td className={css.num}>{s.postedQuantity}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

