import { useCallback, useEffect, useState } from "react";
import type { CardAttemptView, CardOutcomeInput, OfflineSaleView } from "../../shared/ipc-contract";
import { time } from "./format";
import { Icon } from "./Icon";
import { invoke } from "./invoke";
import { KeyScope, useKeyBinding } from "./keymap";
import {
  approvedOutcome,
  cardStage,
  checkNote,
  declinedOutcome,
  MAX_SALE_NOTE_LENGTH,
  NOTE_CATEGORIES,
  saleLabel,
  salesForCard,
  unsettledSentence,
  type NoteCategory,
} from "./offline-records-model";
import styles from "./OfflineRecords.module.css";
import ui from "./ui.module.css";
import { cx, ErrorLine, useAction } from "./useAction";

const PILL = { warn: ui.warn, bad: ui.bad, ok: ui.ok, neutral: ui.neutral } as const;

/**
 * Offline records on This counter (P4 #50): card payments that still need settling, and notes on
 * sales made while the counter was offline. Both are evidence for the back office; nothing here
 * changes a sale, stock, cash or a card payment, and nothing charges a card.
 */
export function OfflineRecords() {
  const [sales, setSales] = useState<OfflineSaleView[] | null>(null);
  const [attempts, setAttempts] = useState<CardAttemptView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [noting, setNoting] = useState<OfflineSaleView | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [s, a] = await Promise.all([
      invoke(() => window.pos.offlineSales()),
      invoke(() => window.pos.cardAttempts()),
    ]);
    setSales(s.ok ? s.value : []);
    setAttempts(a.ok ? a.value : []);
    setLoadError(!s.ok ? s.error.message : !a.ok ? a.error.message : null);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const unsettled = (attempts ?? []).filter((a) => !a.settled);
  const settled = (attempts ?? []).filter((a) => a.settled).slice(0, 5);
  const loading = sales === null || attempts === null;
  const empty = !loading && !sales.length && !attempts.length;

  return (
    <div className={ui.panel}>
      <div className={cx(ui.ph, styles.ph)}>
        <h2>Offline sales and card payments</h2>
        {!loading && unsettled.length > 0 && (
          <span className={cx(ui.pill, ui.warn, styles.right)}>{unsettled.length} to settle</span>
        )}
      </div>
      <div className={styles.body}>
        {loading && <p className={styles.muted}>Loading…</p>}
        <ErrorLine error={loadError} />
        {saved && (
          <p role="status" className={ui.okText}>
            {saved}
          </p>
        )}
        {empty && (
          <p className={styles.muted}>
            Nothing here yet. Sales made while this counter is offline, and card payments taken then, are
            listed here.
          </p>
        )}

        {unsettled.length > 0 && (
          <section aria-label="Card payments to settle">
            <h3 className={styles.sub}>Card payments to settle</h3>
            <p className={styles.muted}>
              {unsettledSentence(unsettled.length)} Synchronisation after an outage waits until they are.
            </p>
            {unsettled.map((attempt) => (
              <CardRow
                key={attempt.attemptId}
                attempt={attempt}
                sales={salesForCard(attempt, sales ?? [])}
                onChanged={() => void load()}
              />
            ))}
          </section>
        )}

        {settled.length > 0 && (
          <section aria-label="Settled card payments">
            <h3 className={styles.sub}>Settled</h3>
            {settled.map((attempt) => (
              <div key={attempt.attemptId} className={styles.row}>
                <div>
                  <b>Rs {attempt.amount}</b>
                  <small>
                    {time(new Date(attempt.startedAt))} · {cardStage(attempt).title}
                  </small>
                </div>
              </div>
            ))}
          </section>
        )}

        {!!sales?.length && (
          <section aria-label="Sales made offline">
            <h3 className={styles.sub}>Sales made offline</h3>
            {sales.slice(0, 20).map((sale) => (
              <div key={sale.saleCommandId} className={styles.row}>
                <div>
                  <b>{saleLabel(sale, time)}</b>
                  <small>
                    {sale.paidByCard ? "Paid with card" : "Paid in cash"}
                    {sale.noteCount > 0 &&
                      ` · ${sale.noteCount} ${sale.noteCount === 1 ? "note" : "notes"} saved`}
                  </small>
                </div>
                <button
                  type="button"
                  className={cx(ui.btn, ui.outline, ui.sm)}
                  onClick={() => {
                    setSaved(null);
                    setNoting(sale);
                  }}
                >
                  Note a problem
                </button>
              </div>
            ))}
          </section>
        )}
      </div>
      {noting && (
        <NoteSheet
          sale={noting}
          onClose={() => setNoting(null)}
          onSaved={() => {
            setNoting(null);
            setSaved("Note saved. The sale itself is unchanged; the back office will see the note.");
            void load();
          }}
        />
      )}
    </div>
  );
}

/** One card payment that still needs an answer, with the buttons that answer it. */
function CardRow({
  attempt,
  sales,
  onChanged,
}: {
  attempt: CardAttemptView;
  sales: OfflineSaleView[];
  onChanged: () => void;
}) {
  const stage = cardStage(attempt);
  const [asking, setAsking] = useState<"approved" | "declined" | null>(null);
  const [reference, setReference] = useState("");
  const [code, setCode] = useState("");
  const { busy, error, run, clear } = useAction();

  function record(outcome: CardOutcomeInput) {
    void run(
      () => invoke(() => window.pos.recordCardOutcome({ attemptId: attempt.attemptId, outcome })),
      () => {
        setAsking(null);
        setReference("");
        setCode("");
        onChanged();
      },
    );
  }

  const outcome =
    asking === "approved"
      ? approvedOutcome(reference, code)
      : asking === "declined"
        ? declinedOutcome(reference)
        : null;
  const answers = stage.canSay.approved || stage.canSay.declined || stage.canSay.notSure;

  return (
    <div className={styles.card}>
      <div className={styles.cardH}>
        <div>
          <b>Rs {attempt.amount}</b>
          <small>Started {time(new Date(attempt.startedAt))}</small>
        </div>
        <span className={cx(ui.pill, PILL[stage.tone], styles.right)}>{stage.title}</span>
      </div>
      <p className={styles.muted}>{stage.detail}</p>

      {answers && !asking && (
        <div className={styles.actions} role="group" aria-label="What did the card machine say?">
          {stage.canSay.approved && (
            <button
              type="button"
              className={cx(ui.btn, ui.outline, ui.sm)}
              onClick={() => {
                clear();
                setAsking("approved");
              }}
            >
              Approved
            </button>
          )}
          {stage.canSay.declined && (
            <button
              type="button"
              className={cx(ui.btn, ui.outline, ui.sm)}
              onClick={() => {
                clear();
                setAsking("declined");
              }}
            >
              Declined
            </button>
          )}
          {stage.canSay.notSure && (
            <button
              type="button"
              className={cx(ui.btn, ui.soft, ui.sm)}
              disabled={busy}
              onClick={() => record({ kind: "not_sure" })}
            >
              Not sure
            </button>
          )}
        </div>
      )}

      {asking && (
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            if (outcome && !busy) record(outcome);
          }}
        >
          <p className={styles.muted}>
            {asking === "approved"
              ? "Copy these from the card machine's slip. Never type a card number."
              : "Only choose Declined if the card machine itself shows this payment was declined or never taken."}
          </p>
          <label className={ui.label}>
            <span>Card machine reference</span>
            <input
              className={ui.in}
              value={reference}
              maxLength={64}
              autoComplete="off"
              onChange={(e) => setReference(e.target.value)}
            />
          </label>
          {asking === "approved" && (
            <label className={ui.label}>
              <span>Approval code</span>
              <input
                className={ui.in}
                value={code}
                maxLength={32}
                autoComplete="off"
                onChange={(e) => setCode(e.target.value)}
              />
            </label>
          )}
          <div className={styles.actions}>
            <button type="button" className={cx(ui.btn, ui.outline, ui.sm)} onClick={() => setAsking(null)}>
              Cancel
            </button>
            <button type="submit" className={cx(ui.btn, ui.primary, ui.sm)} disabled={!outcome || busy}>
              {asking === "approved" ? "Save as approved" : "Save as declined"}
            </button>
          </div>
        </form>
      )}

      {stage.needsSale &&
        (sales.length === 0 ? (
          <p className={styles.muted}>
            No offline sale paid by card is waiting for this payment yet. Once the sale is rung up it can be
            matched here.
          </p>
        ) : (
          sales.map((sale) => (
            <div key={sale.saleCommandId} className={styles.row}>
              <div>
                <b>{saleLabel(sale, time)}</b>
                <small>{sale.total === attempt.amount ? "Same amount as this payment" : "Different amount"}</small>
              </div>
              <button
                type="button"
                className={cx(ui.btn, ui.primary, ui.sm)}
                disabled={busy || !attempt.providerReference}
                onClick={() =>
                  record({
                    kind: "paid_sale",
                    reference: attempt.providerReference ?? "",
                    saleCommandId: sale.saleCommandId,
                  })
                }
              >
                This is the sale
              </button>
            </div>
          ))
        ))}
      <ErrorLine error={error} />
    </div>
  );
}

/** The "Note a problem with this sale" sheet. The note is evidence only. */
function NoteSheet({
  sale,
  onClose,
  onSaved,
}: {
  sale: OfflineSaleView;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [category, setCategory] = useState<NoteCategory>("quantity_error");
  const [text, setText] = useState("");
  const { busy, error, run } = useAction();
  useKeyBinding("Escape", onClose);
  const note = checkNote(text);

  function save() {
    if (!note.ok || busy) return;
    void run(
      () =>
        invoke(() =>
          window.pos.noteSaleProblem({
            saleCommandId: sale.saleCommandId,
            category,
            description: note.text,
          }),
        ),
      onSaved,
    );
  }

  return (
    <KeyScope layer>
      <div className={styles.scrim} onClick={onClose} aria-hidden="true" />
      <div className={styles.sheet} role="dialog" aria-modal="true" aria-labelledby="note-title">
        <div className={styles.sheetH}>
          <div>
            <div className={ui.eyebrow}>Offline sale</div>
            <h2 id="note-title">Note a problem with this sale</h2>
            <small>{saleLabel(sale, time)}</small>
          </div>
          <button type="button" className={cx(ui.btn, ui.ghost, styles.close)} onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>
        <div className={styles.sheetBody}>
          <div className={ui.note}>
            <Icon name="alert-triangle" />
            <div>
              This only leaves a note for the back office. It does not change the sale, the stock, the cash or
              the card payment.
            </div>
          </div>
          <fieldset className={styles.cats}>
            <legend>What went wrong?</legend>
            {NOTE_CATEGORIES.map((c) => (
              <label key={c.value} className={styles.cat}>
                <input
                  type="radio"
                  name="note-category"
                  checked={category === c.value}
                  onChange={() => setCategory(c.value)}
                />
                <span>
                  <b>{c.label}</b>
                  <small>{c.hint}</small>
                </span>
              </label>
            ))}
          </fieldset>
          <label className={ui.label}>
            <span>Tell the back office what happened</span>
            <textarea
              className={cx(ui.in, styles.area)}
              rows={5}
              value={text}
              maxLength={MAX_SALE_NOTE_LENGTH}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          <small className={styles.muted}>
            Never type a card number. {text.trim().length} of {MAX_SALE_NOTE_LENGTH} characters.
          </small>
          <ErrorLine error={error} />
        </div>
        <div className={styles.sheetF}>
          <span className={ui.grow} />
          <button type="button" className={cx(ui.btn, ui.outline, ui.lg)} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={cx(ui.btn, ui.primary, ui.lg)} disabled={!note.ok || busy} onClick={save}>
            Save note
          </button>
        </div>
      </div>
    </KeyScope>
  );
}
