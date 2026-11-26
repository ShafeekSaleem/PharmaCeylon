import { useCallback, useEffect, useRef, useState } from "react";
import {
  type CounterMismatchProblem,
  type CounterMismatchReport,
  type CounterWorkDetail,
  type CounterWorkReceiptLine,
  type CounterWorkTransferLine,
  COUNTER_MISMATCH_HOLDS,
  COUNTER_MISMATCH_PROBLEM_LABEL,
} from "@pharmaceylon/shared";
import type { CounterWorkItem } from "../../shared/ipc-contract";
import {
  buildMismatchInput,
  countLabel,
  emptyMismatchForm,
  lineFingerprint,
  mismatchButtonLabel,
  mismatchIssue,
  mismatchKindOf,
  mismatchLineChoices,
  needsCount,
  needsLine,
  needsNote,
  problemChoices,
  type MismatchForm,
} from "./counter-document-model";
import styles from "./CounterDocumentPane.module.css";
import { Icon } from "./Icon";
import { invoke } from "./invoke";
import ui from "./ui.module.css";
import { cx } from "./useAction";

/** Ticks kept on this computer: `documentId:lineIndex` to the line as approved when it was ticked. */
const tickStore = new Map<string, string>();

/** Forget every tick kept on this computer (used between tests). */
export function clearCheckedLines() {
  tickStore.clear();
}

function expiry(day: string | null) {
  return day ? day.slice(0, 7) : "—";
}

function ReceiptLines({
  lines,
  ticked,
  onToggle,
  disabled,
}: {
  lines: ReadonlyArray<CounterWorkReceiptLine>;
  ticked: (line: CounterWorkReceiptLine) => boolean;
  onToggle: (line: CounterWorkReceiptLine) => void;
  disabled: boolean;
}) {
  return (
    <table className={styles.lines}>
      <thead>
        <tr>
          <th aria-label="Checked" />
          <th>Product</th>
          <th>Batch</th>
          <th>Expiry</th>
          <th className={styles.num}>Packs</th>
          <th className={styles.num}>Units</th>
          <th className={styles.num}>Free</th>
          <th className={styles.num}>Damaged</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((l) => (
          <tr key={l.index}>
            <td>
              <input
                type="checkbox"
                aria-label={`Checked: ${l.productName}`}
                checked={ticked(l)}
                disabled={disabled}
                onChange={() => onToggle(l)}
              />
            </td>
            <td>
              {l.productName}
              {l.packLabel && <small>{l.packLabel}</small>}
            </td>
            <td>{l.batchNo ?? "—"}</td>
            <td>{expiry(l.expiryDate)}</td>
            <td className={styles.num}>{l.packs ?? "—"}</td>
            <td className={styles.num}>{l.receivedQty}</td>
            <td className={styles.num}>{l.freeQty || "—"}</td>
            <td className={styles.num}>{l.damagedQty || "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TransferLines({ lines }: { lines: ReadonlyArray<CounterWorkTransferLine> }) {
  return (
    <table className={styles.lines}>
      <thead>
        <tr>
          <th>Product</th>
          <th>Batch</th>
          <th>Expiry</th>
          <th className={styles.num}>Approved</th>
          <th className={styles.num}>Already in</th>
          <th className={styles.num}>On the way</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((l) => (
          <tr key={l.transferItemId}>
            <td>
              {l.productName}
              {l.packLabel && <small>{l.packLabel}</small>}
            </td>
            <td>{l.batchNo ?? "—"}</td>
            <td>{expiry(l.expiryDate)}</td>
            <td className={styles.num}>{l.qty}</td>
            <td className={styles.num}>{l.receivedQty || "—"}</td>
            <td className={styles.num}>{l.remainingQty}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ReportRow({ report }: { report: CounterMismatchReport }) {
  return (
    <li>
      <b>{COUNTER_MISMATCH_PROBLEM_LABEL[report.problem]}</b>
      {report.lineLabel ? ` · ${report.lineLabel}` : ""}
      {report.countedQty !== null ? ` · ${report.countedQty} ${report.countUnit ?? ""}`.trimEnd() : ""}
      {report.note ? ` — “${report.note}”` : ""}
      <small>
        Sent by {report.reported.name ?? "a colleague"}
        {report.holding ? " · waiting for the approver" : ""}
      </small>
    </li>
  );
}

/**
 * What the counter confirms, line by line, and the way to say it doesn't match (decision 1).
 * The lines are the approved document as it stands; the counter never edits them. Nothing posts
 * from here and no stock moves: a report goes to the approver, who corrects the document or
 * keeps it as approved.
 */
export function CounterDocumentPane({
  item,
  online,
  canPost,
  onReported,
}: {
  item: CounterWorkItem;
  online: boolean;
  /** Nothing else at this counter is waiting to be confirmed: never do a second thing while one is unknown. */
  canPost: boolean;
  /** The list is read again so a held item shows as waiting for a corrected version. */
  onReported: () => void;
}) {
  const [detail, setDetail] = useState<CounterWorkDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<MismatchForm>(emptyMismatchForm);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sent, setSent] = useState<CounterMismatchReport | null>(null);
  // One key per report being written: a resend after a lost answer returns the same report.
  const keyRef = useRef<string | null>(null);
  // Any edit makes it a different report: it must not go out under the key of one that may have landed.
  const editForm = (change: (f: MismatchForm) => MismatchForm) => {
    keyRef.current = null;
    setForm(change);
  };
  // Only the newest read may fill the pane: a slow answer for an item left behind is dropped.
  const readId = useRef(0);
  // Ticks are a check kept on this computer, never sent. Each is kept against the line as
  // approved, so a corrected version keeps the ticks on the lines it did not change.
  const [, setTickVersion] = useState(0);
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const [posted, setPosted] = useState<{ reference: string; alreadyApplied: boolean } | null>(null);

  const load = useCallback(() => {
    const mine = ++readId.current;
    void invoke(() =>
      window.pos.counterWorkDetail({
        kind: item.kind as Parameters<typeof window.pos.counterWorkDetail>[0]["kind"],
        id: item.id,
      }),
    ).then((result) => {
      if (mine !== readId.current) return;
      setLoading(false);
      if (result.ok) {
        setDetail(result.value);
        setLoadError(null);
      } else {
        setDetail(null);
        setLoadError(result.error.message);
      }
    });
  }, [item.kind, item.id]);

  useEffect(() => {
    setLoading(true);
    setOpen(false);
    setForm(emptyMismatchForm);
    setSent(null);
    setSendError(null);
    setPostError(null);
    setPosted(null);
    keyRef.current = null;
    load();
  }, [load, item.approval.evidenceId, item.approval.currentVersion]);

  if (loading)
    return (
      <div className={styles.content}>
        <div className={cx(ui.note, styles.waiting)} aria-busy="true">
          <Icon name="clock" />
          <div>Loading the lines…</div>
        </div>
      </div>
    );
  if (!detail)
    return (
      <div className={styles.content}>
        <div className={cx(ui.note, ui.noteWarn)} role="alert">
          <Icon name="alert-triangle" />
          <div>
            <b>The lines could not be loaded</b>
            {loadError ?? "Try again in a moment."}
          </div>
        </div>
        <button type="button" className={cx(ui.btn, ui.outline)} onClick={() => { setLoading(true); load(); }}>
          Try again
        </button>
      </div>
    );

  const kind = mismatchKindOf(detail);
  const choices = mismatchLineChoices(detail);
  const problems = kind ? problemChoices(kind) : [];
  const chosen = choices.find((c) => c.key === form.lineKey) ?? null;
  const issue = mismatchIssue(form);
  const holding = detail.mismatches.some((m) => m.holding);
  const approvalOk = detail.approval.state === "matches" || detail.approval.state === "not_needed";
  const canReport = kind !== null && online && approvalOk && detail.approval.currentVersion !== null;

  const chooseProblem = (problem: CounterMismatchProblem) =>
    editForm((f) => ({
      ...f,
      problem,
      lineKey: problem === "not_on_note" ? null : f.lineKey,
      count: needsCount(problem) ? f.count : "",
    }));
  const receiptLines =
    detail.kind === "prepared_receipt" || detail.kind === "held_delivery"
      ? (detail.lines as ReadonlyArray<CounterWorkReceiptLine>)
      : null;
  const ticks = receiptLines
    ? receiptLines.filter((l) => tickStore.get(`${detail.id}:${l.index}`) === lineFingerprint(l)).length
    : 0;
  const allTicked = receiptLines !== null && ticks === receiptLines.length;
  const unitsToStock = receiptLines?.reduce((n, l) => n + l.unitsToStock, 0) ?? 0;
  const damaged = receiptLines?.reduce((n, l) => n + l.damagedQty, 0) ?? 0;
  const canPostNow =
    receiptLines !== null &&
    receiptLines.length > 0 &&
    allTicked &&
    online &&
    canPost &&
    !posting &&
    detail.approval.state === "matches" &&
    !holding;

  const post = async () => {
    if (!receiptLines || !canPostNow) return;
    const kindToPost = detail.kind as "prepared_receipt" | "held_delivery";
    setPosting(true);
    setPostError(null);
    const result = await invoke(() => window.pos.postCounterReceipt({ kind: kindToPost, id: detail.id }));
    setPosting(false);
    if (!result.ok) {
      setPostError(result.error.message);
      // A changed approval or a new report shows on the document, so read it again.
      load();
      onReported();
      return;
    }
    receiptLines.forEach((l) => tickStore.delete(`${detail.id}:${l.index}`));
    setPosted({ reference: result.value.reference, alreadyApplied: result.value.alreadyApplied });
    onReported();
  };

  const send = async () => {
    keyRef.current ??= crypto.randomUUID();
    const body = buildMismatchInput(detail, form, keyRef.current);
    if (!body || sending) return;
    setSending(true);
    setSendError(null);
    const result = await invoke(() => window.pos.reportCounterMismatch(body));
    setSending(false);
    if (!result.ok) {
      setSendError(result.error.message);
      // The document moved on while this was open: read it again so the report is raised against what is current.
      if (result.error.code === "CHANGED_SINCE_OPENED") {
        keyRef.current = null;
        load();
      }
      return;
    }
    setSent(result.value);
    setOpen(false);
    setForm(emptyMismatchForm);
    keyRef.current = null;
    onReported();
    load();
  };

  return (
    <div className={styles.content}>
      {detail.approval.state === "changed" && (
        <div className={cx(ui.note, ui.noteWarn)} role="alert">
          <Icon name="alert-triangle" />
          <div>
            <b>Changed after approval</b>
            {detail.approval.changes.length
              ? detail.approval.changes.join("; ")
              : "Ask for the new version to be approved on the web."}{" "}
            Nothing can be posted from here until it is approved again.
          </div>
        </div>
      )}
      {detail.approval.state === "revoked" && (
        <div className={cx(ui.note, ui.noteWarn)} role="alert">
          <Icon name="alert-triangle" />
          <div>
            <b>The approval was withdrawn on the web</b>
            Nothing can be posted from here.
          </div>
        </div>
      )}
      {detail.notes.map((n) => (
        <div key={n.label + n.text} className={cx(ui.note, styles.waiting)} role="note">
          <Icon name="file-text" />
          <div>
            <b>
              {n.label}
              {n.by ? ` · ${n.by}` : ""}
            </b>
            {n.text}
          </div>
        </div>
      ))}

      {detail.kind === "transfer_ship" || detail.kind === "transfer_receive" ? (
        <TransferLines lines={detail.lines as ReadonlyArray<CounterWorkTransferLine>} />
      ) : receiptLines ? (
        <ReceiptLines
          lines={receiptLines}
          ticked={(l) => tickStore.get(`${detail.id}:${l.index}`) === lineFingerprint(l)}
          onToggle={(l) => {
            const key = `${detail.id}:${l.index}`;
            if (tickStore.get(key) === lineFingerprint(l)) tickStore.delete(key);
            else tickStore.set(key, lineFingerprint(l));
            setTickVersion((v) => v + 1);
          }}
          disabled={posting || posted !== null}
        />
      ) : null}
      {receiptLines && (
        <div className={cx(ui.note, styles.waiting)} role="note">
          <Icon name="package-check" />
          <div>
            <b>
              {unitsToStock} {unitsToStock === 1 ? "unit" : "units"} go on the shelf
              {damaged > 0 ? `, ${damaged} damaged go to quarantine` : ""}
            </b>
            The counter confirms the delivery as approved; it never changes a quantity, batch or price.
            {allTicked ? "" : ` Tick every line as you check it (${ticks} of ${receiptLines.length}).`}
          </div>
        </div>
      )}
      {posted && (
        <p className={ui.okText} role="status">
          {posted.alreadyApplied ? "Already posted. " : "Posted. "}
          {posted.reference} is in stock.
        </p>
      )}
      {postError && (
        <p role="alert" className={ui.badText}>
          {postError}
        </p>
      )}
      {receiptLines && !posted && (
        <div className={styles.actions}>
          {!canPost && <small className={styles.hint}>Confirm the action waiting at this counter first.</small>}
          {canPost && receiptLines.length === 0 && (
            <small className={styles.hint}>This delivery has no lines to post.</small>
          )}
          <button
            type="button"
            className={cx(ui.btn, ui.primary)}
            disabled={!canPostNow}
            onClick={() => void post()}
          >
            <Icon name="check-circle" />
            {posting ? "Posting…" : "Post receiving"}
          </button>
        </div>
      )}

      {detail.mismatches.length > 0 && (
        <div className={cx(ui.note, ui.noteWarn)} role="status">
          <Icon name="alert-triangle" />
          <div>
            <b>{holding ? "Sent to the approver as not matching" : "Reported to the approver"}</b>
            {holding && kind && COUNTER_MISMATCH_HOLDS[kind]
              ? "It waits here until a corrected version is approved, or the approver keeps it as it is."
              : "The approver has these in Daily work."}
            <ul className={styles.reports}>
              {detail.mismatches.map((m) => (
                <ReportRow key={m.id} report={m} />
              ))}
            </ul>
          </div>
        </div>
      )}
      {sent && (
        <p className={ui.okText} role="status">
          Sent to the approver. Nothing was posted.
        </p>
      )}

      {kind && !open && (
        <div>
          <button
            type="button"
            className={cx(ui.btn, ui.outline)}
            disabled={!canReport}
            onClick={() => {
              setSent(null);
              setOpen(true);
            }}
          >
            <Icon name="alert-triangle" />
            {mismatchButtonLabel(kind)}
          </button>
          {!canReport && (
            <small className={styles.hint}>
              {!online
                ? "Reporting needs the server. This counter is offline."
                : "Reporting is off until this is approved again on the web."}
            </small>
          )}
        </div>
      )}

      {kind && open && (
        <form
          className={styles.sheet}
          aria-label={mismatchButtonLabel(kind)}
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <div className={ui.f}>
            <span className={ui.label}>What's wrong</span>
            <div className={styles.choices} role="radiogroup" aria-label="What's wrong">
              {problems.map((p) => (
                <button
                  key={p.problem}
                  type="button"
                  role="radio"
                  aria-checked={form.problem === p.problem}
                  tabIndex={form.problem === p.problem || (form.problem === null && p === problems[0]) ? 0 : -1}
                  onKeyDown={(e) => {
                    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
                    if (!step) return;
                    e.preventDefault();
                    const next = problems[(problems.indexOf(p) + step + problems.length) % problems.length]!;
                    chooseProblem(next.problem);
                    (e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="radio"]')[problems.indexOf(next)])?.focus();
                  }}
                  className={cx(styles.choice, form.problem === p.problem && styles.choiceOn)}
                  disabled={sending}
                  onClick={() => chooseProblem(p.problem)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          {needsLine(form.problem) && (
            <label className={ui.f}>
              <span className={ui.label}>Line</span>
              <select
                className={ui.in}
                value={form.lineKey ?? ""}
                disabled={sending}
                onChange={(e) => editForm((f) => ({ ...f, lineKey: e.target.value || null }))}
              >
                <option value="">Choose the line…</option>
                {choices.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {needsCount(form.problem) && kind && form.problem && (
            <label className={ui.f}>
              <span className={ui.label}>
                {countLabel(form.problem, chosen?.unit ?? "units", kind)}
                {chosen ? ` (the document says ${chosen.expected})` : ""}
              </span>
              <input
                className={ui.in}
                inputMode="numeric"
                value={form.count}
                disabled={sending}
                onChange={(e) => editForm((f) => ({ ...f, count: e.target.value.replace(/\D/g, "").slice(0, 7) }))}
              />
            </label>
          )}
          <label className={ui.f}>
            <span className={ui.label}>Note{needsNote(form.problem) ? "" : " (optional)"}</span>
            <textarea
              className={ui.in}
              rows={3}
              maxLength={500}
              value={form.note}
              disabled={sending}
              onChange={(e) => editForm((f) => ({ ...f, note: e.target.value }))}
            />
          </label>
          {sendError && (
            <p role="alert" className={ui.badText}>
              {sendError}
            </p>
          )}
          <div className={styles.actions}>
            <button
              type="button"
              className={cx(ui.btn, ui.outline)}
              disabled={sending}
              onClick={() => {
                keyRef.current = null;
                setOpen(false);
                setForm(emptyMismatchForm);
                setSendError(null);
              }}
            >
              Cancel
            </button>
            <button type="submit" className={cx(ui.btn, ui.primary)} disabled={sending || issue !== null}>
              <Icon name="arrow-right" />
              {sending ? "Sending…" : "Send to the approver"}
            </button>
            {issue && <small className={styles.hint}>{issue}</small>}
          </div>
        </form>
      )}
    </div>
  );
}
