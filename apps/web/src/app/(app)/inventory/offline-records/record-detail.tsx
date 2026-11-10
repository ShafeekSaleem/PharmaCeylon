"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { Alert } from "@/components/alert";
import {
  ActionButton,
  ApprovalEvidencePanel,
  StatusBadge,
} from "@/components/ui";
import { formatMoney } from "@/lib/money";
import { when } from "../stock-cases/case-detail";
import css from "../stock-cases/stock-cases.module.css";
import type {
  Decision,
  EntryKind,
  RefusedRecordDetail,
  SaleEntry,
  Settlement,
} from "./types";

export const REVIEW_PERMISSION = "sales.review_offline_entries";

export const KIND_LABELS: Record<EntryKind, string> = {
  ordinary_sale: "Offline sale",
  shift_open: "Shift opened offline",
  shift_close: "Shift closed offline",
};

const DECISIONS: Record<
  Decision,
  { title: string; help: (kind: EntryKind) => string }
> = {
  recorded: {
    title: "Record it as it happened",
    help: (kind) =>
      kind === "ordinary_sale"
        ? "The sale is kept with the counter's prices, payment, seller and shift. Its stock waits on a stock case, settled at the counter; nothing moves here."
        : kind === "shift_open"
          ? "The shift is opened on the till as the counter recorded it."
          : "The shift is closed with the counter's cash count; the variance is worked out from the shift's sales.",
  },
  not_honoured: {
    title: "Don't honour it",
    help: (kind) =>
      kind === "ordinary_sale"
        ? "No sale, payment or stock is recorded. Any cash the counter took shows as that shift's variance."
        : "Nothing is recorded on the till. The record is kept as evidence.",
  },
};

export const SETTLEMENT_LABELS: Record<Settlement["status"], string> = {
  prepared: "Needs approval",
  settled: "Settled",
  cancelled: "Cancelled",
};

export const minor = (n: number) => formatMoney(n / 100);
const name = (p: { name: string | null } | null) => p?.name ?? "—";

/**
 * One refused offline record: the entry exactly as the counter signed it, why the server refused
 * it, and the decision on it. Approving the decision settles it on the server; the counter learns
 * the outcome the next time it sends the record, within a minute.
 */
export function RecordDetail({
  detail,
  busy,
  userId,
  canSelfApprove,
  onPrepare,
  onApprove,
  onCancel,
}: {
  detail: RefusedRecordDetail;
  busy: boolean;
  userId: string | null;
  canSelfApprove: boolean;
  onPrepare: (body: { decision: Decision; reason: string }) => Promise<boolean>;
  onApprove: (settlement: Settlement, approvalId: string) => Promise<boolean>;
  onCancel: (settlement: Settlement) => Promise<boolean>;
}) {
  const waiting =
    detail.settlements.find((s) => s.status === "prepared") ?? null;
  const settled =
    detail.settlements.find((s) => s.status === "settled") ?? null;
  // One approval ID per displayed content, so a retried click can't approve twice.
  const approvalIds = useRef<Record<string, string>>({});
  const approve = (s: Settlement) => {
    const slot = `${s.id}:${s.approvalReview?.expectedDigest}`;
    approvalIds.current[slot] ??= crypto.randomUUID();
    return onApprove(s, approvalIds.current[slot]);
  };
  const { entry } = detail;

  return (
    <div className={css.form}>
      <section className={css.card} aria-label="Refused record">
        <h2 className={css.cardTitle}>
          {KIND_LABELS[detail.kind]}{" "}
          <StatusBadge
            status={
              detail.state === "open"
                ? "blocked"
                : detail.state === "settled"
                  ? "completed"
                  : "cancelled"
            }
            label={
              detail.state === "open"
                ? "Blocking the counter"
                : detail.state === "settled"
                  ? "Settled"
                  : "Overtaken"
            }
          />
        </h2>
        <Alert variant={detail.state === "open" ? "warning" : "info"}>
          <strong>Why it was refused:</strong> {detail.refusal.explanation}
        </Alert>
        <dl className={css.facts}>
          <div>
            <dt>When (counter's clock)</dt>
            <dd>{when(entry.occurredAt)}</dd>
          </div>
          <div>
            <dt>By</dt>
            <dd>{name(entry.staff)}</dd>
          </div>
          <div>
            <dt>Counter</dt>
            <dd>
              {detail.counter.label ?? "—"} · record {detail.sequence}
            </dd>
          </div>
          <div>
            <dt>Shift</dt>
            <dd>
              {entry.shift
                ? `${entry.shift.number} · opened ${when(entry.shift.openedAt)}${entry.shift.closedAt ? ` · closed ${when(entry.shift.closedAt)}` : ""}`
                : "Not on the server"}
            </dd>
          </div>
          <div>
            <dt>First sent</dt>
            <dd>
              {when(detail.firstReceivedAt)} by {name(detail.receivedBy)}
              {detail.attempts > 1 ? ` · sent ${detail.attempts} times` : ""}
            </dd>
          </div>
          <div>
            <dt>Offline since</dt>
            <dd>{when(entry.offlineStartedAt)}</dd>
          </div>
          {entry.kind === "shift_open" ? (
            <div>
              <dt>Opening cash</dt>
              <dd>{minor(entry.openingCashMinor)}</dd>
            </div>
          ) : null}
          {entry.kind === "shift_close" ? (
            <>
              <div>
                <dt>Cash counted</dt>
                <dd>{minor(entry.closingCashCountMinor)}</dd>
              </div>
              <div>
                <dt>Counter expected</dt>
                <dd>{minor(entry.counterExpectedCashMinor)}</dd>
              </div>
              {entry.assistanceReason ? (
                <div>
                  <dt>Closed for the cashier</dt>
                  <dd>{entry.assistanceReason}</dd>
                </div>
              ) : null}
            </>
          ) : null}
        </dl>
        {entry.kind === "ordinary_sale" ? <SaleLines entry={entry} /> : null}
      </section>

      <section className={css.card} aria-label="Decision">
        <h2 className={css.cardTitle}>Decision</h2>
        {settled ? (
          <Settled detail={detail} settlement={settled} />
        ) : waiting ? (
          <Waiting
            kind={detail.kind}
            settlement={waiting}
            busy={busy}
            canApprove={waiting.requester?.id !== userId || canSelfApprove}
            onApprove={() => void approve(waiting)}
            onCancel={() => void onCancel(waiting)}
          />
        ) : detail.settleBlocker ? (
          <p className={css.sub}>{detail.settleBlocker.message}</p>
        ) : (
          <DecisionForm detail={detail} busy={busy} onPrepare={onPrepare} />
        )}
      </section>
    </div>
  );
}

function SaleLines({ entry }: { entry: SaleEntry }) {
  return (
    <>
      <table className={css.table} aria-label="Receipt">
        <thead>
          <tr>
            <th>Item</th>
            <th>Batch</th>
            <th className={css.num}>Qty</th>
            <th className={css.num}>Price</th>
            <th className={css.num}>Tax</th>
            <th className={css.num}>Total</th>
          </tr>
        </thead>
        <tbody>
          {entry.lines.map((line) => (
            <tr key={line.snapshotLineId}>
              <td>{line.product?.name ?? "Not in the saved stock"}</td>
              <td>{line.batch?.batchNo ?? "—"}</td>
              <td className={css.num}>{line.quantity}</td>
              <td className={css.num}>{minor(line.unitPriceMinor)}</td>
              <td className={css.num}>{minor(line.taxMinor)}</td>
              <td className={css.num}>{minor(line.lineTotalMinor)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className={css.facts}>
        <div>
          <dt>Total</dt>
          <dd>{minor(entry.totalMinor)}</dd>
        </div>
        <div>
          <dt>Paid</dt>
          <dd>
            {entry.payments
              .map((p) =>
                p.method === "cash"
                  ? `Cash ${minor(p.amountMinor)} (tendered ${minor(p.tenderedMinor)}, change ${minor(p.changeMinor)})`
                  : `Card ${minor(p.amountMinor)} · ref ${p.providerReference}`,
              )
              .join("; ")}
          </dd>
        </div>
      </dl>
    </>
  );
}

/** Record it or don't honour it, with a reason either way. Nothing is written until it is approved. */
function DecisionForm({
  detail,
  busy,
  onPrepare,
}: {
  detail: RefusedRecordDetail;
  busy: boolean;
  onPrepare: (body: { decision: Decision; reason: string }) => Promise<boolean>;
}) {
  const recordable = detail.recordable?.ok ?? false;
  const [decision, setDecision] = useState<Decision>(
    recordable ? "recorded" : "not_honoured",
  );
  const [reason, setReason] = useState("");
  return (
    <div className={css.form}>
      <fieldset className={css.kinds}>
        <legend>What should the server do with it?</legend>
        {(Object.keys(DECISIONS) as Decision[]).map((d) => (
          <label key={d} className={css.kind}>
            <input
              type="radio"
              name="decision"
              value={d}
              checked={decision === d}
              onChange={() => setDecision(d)}
              disabled={busy || (d === "recorded" && !recordable)}
            />
            <span>
              <strong>{DECISIONS[d].title}</strong>
              <br />
              <span className={css.sub}>
                {DECISIONS[d].help(detail.kind)}
                {d === "recorded" && !recordable && detail.recordable?.message
                  ? ` Not possible: ${detail.recordable.message}`
                  : ""}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      <label className={css.kind}>
        <span>Reason</span>
        <textarea
          aria-label="Reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          rows={3}
          disabled={busy}
        />
      </label>
      <div className={css.actions}>
        <ActionButton
          disabled={busy || !reason.trim()}
          onClick={() => void onPrepare({ decision, reason: reason.trim() })}
        >
          Prepare decision
        </ActionButton>
      </div>
    </div>
  );
}

function Waiting({
  kind,
  settlement,
  busy,
  canApprove,
  onApprove,
  onCancel,
}: {
  kind: EntryKind;
  settlement: Settlement;
  busy: boolean;
  canApprove: boolean;
  onApprove: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <p>
        <strong>{DECISIONS[settlement.decision].title}</strong>
        <span className={css.sub}> · {settlement.reason}</span>
      </p>
      <p className={css.sub}>{DECISIONS[settlement.decision].help(kind)}</p>
      <ApprovalEvidencePanel
        title="Decision approval"
        approvedVersion={null}
        currentVersion={settlement.approvalVersion}
        status="prepared"
        statusLabel="Needs approval"
        requester={
          settlement.requester
            ? { name: name(settlement.requester), at: settlement.requestedAt }
            : null
        }
        approver={null}
        executor={null}
      />
      <div className={css.actions}>
        <ActionButton variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel decision
        </ActionButton>
        {canApprove && settlement.approvalReview ? (
          <ActionButton onClick={onApprove} disabled={busy}>
            Approve and settle
          </ActionButton>
        ) : null}
      </div>
    </>
  );
}

function Settled({
  detail,
  settlement,
}: {
  detail: RefusedRecordDetail;
  settlement: Settlement;
}) {
  return (
    <>
      <p>
        <strong>{DECISIONS[settlement.decision].title}</strong>
        <span className={css.sub}> · {settlement.reason}</span>
      </p>
      <ApprovalEvidencePanel
        title="Decision approval"
        approvedVersion={settlement.approvalVersion}
        currentVersion={settlement.approvalVersion}
        status="completed"
        statusLabel={`Settled: ${DECISIONS[settlement.decision].title.toLowerCase()}`}
        requester={{
          name: name(settlement.requester),
          at: settlement.requestedAt,
        }}
        approver={{
          name: name(settlement.approver),
          at: settlement.approvedAt,
        }}
        executor={null}
      />
      {settlement.sale ? (
        <p>
          Recorded as sale {settlement.sale.invoiceNo ?? settlement.sale.id}.{" "}
          {settlement.sale.stockCaseId ? (
            <Link
              href={`/inventory/stock-cases?caseId=${settlement.sale.stockCaseId}`}
            >
              Its stock waits on a stock case
            </Link>
          ) : null}
        </p>
      ) : null}
      {detail.state === "settled" ? (
        <p className={css.sub}>
          The counter learns this the next time it sends the record, within a
          minute, and carries on.
        </p>
      ) : null}
    </>
  );
}
