import { useState } from "react";
import type { ActionResult, CardAttemptView } from "../../shared/ipc-contract";
import { Icon } from "./Icon";
import styles from "./OfflineCounter.module.css";
import { money } from "./sell-model";
import ui from "./ui.module.css";
import { cx, ErrorLine, useAction } from "./useAction";

/**
 * P4 #50: one card payment on an offline sale, on the branch's own card machine. It is saved
 * before the machine is asked to charge, then the cashier records what the machine said. Nothing
 * is charged twice: until it is settled, the sale can't take another card or change.
 */

export type OfflineCardAttempt = {
  attemptId: string;
  amountMinor: number;
  state: CardAttemptView["state"];
  reference: string | null;
  approvalCode: string | null;
};

/** Settled for good: the sale can no longer use it, and another card may be tried. */
export const cardFinished = (attempt: OfflineCardAttempt | null) =>
  !attempt ||
  ["declined", "not_used", "linked_to_sale"].includes(attempt.state);

type Form = null | "approved" | "declined" | "not_used";

/** Today's date at the time on the slip, as ISO; null for a time that isn't one. */
export function slipTime(hhmm: string, now = new Date()): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const at = new Date(now);
  at.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (Number.isNaN(at.getTime()) || Number(m[1]) > 23 || Number(m[2]) > 59)
    return null;
  // A slip can't be from the future: a time later than now was yesterday's.
  if (at.getTime() > now.getTime() + 60_000) at.setDate(at.getDate() - 1);
  return at.toISOString();
}

const hhmm = (d: Date) =>
  `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

export function OfflineCard({
  amountMinor,
  attempt,
  canStart,
  onPrepare,
  onAttempt,
}: {
  amountMinor: number;
  attempt: OfflineCardAttempt | null;
  /** The cart is priced and has nothing the saved stock refuses. */
  canStart: boolean;
  onPrepare: () => Promise<ActionResult<{ attemptId: string }>>;
  onAttempt: (attempt: OfflineCardAttempt | null) => void;
}) {
  const { busy, error, run, clear } = useAction();
  const [form, setForm] = useState<Form>(null);
  const [reference, setReference] = useState("");
  const [code, setCode] = useState("");
  const [at, setAt] = useState(() => hhmm(new Date()));
  const [settlement, setSettlement] = useState<
    "reversed_on_machine" | "refund_owed"
  >("reversed_on_machine");
  const [reason, setReason] = useState("");

  function record(
    outcome: Parameters<Window["pos"]["offlineCardOutcome"]>[0]["outcome"],
    after: Partial<OfflineCardAttempt> = {},
  ) {
    if (!attempt) return;
    void run(
      () =>
        window.pos.offlineCardOutcome({
          attemptId: attempt.attemptId,
          outcome,
        }),
      ({ state }) => {
        setForm(null);
        onAttempt({ ...attempt, ...after, state });
      },
    );
  }

  if (!attempt || cardFinished(attempt))
    return (
      <div className={styles.card}>
        {attempt?.state === "declined" && (
          <div className={cx(ui.note, ui.noteWarn)} role="status">
            <Icon name="alert-triangle" />
            <div>
              {attempt.reference
                ? "The card was declined."
                : "Nothing was charged."}{" "}
              Try the card again, or take cash.
            </div>
          </div>
        )}
        {attempt?.state === "not_used" && (
          <div className={ui.note} role="status">
            <Icon name="info" />
            <div>
              That card payment is recorded as not used. A manager reviews it.
            </div>
          </div>
        )}
        <button
          type="button"
          className={cx(ui.btn, ui.outline, ui.lg)}
          disabled={busy || !canStart || amountMinor <= 0}
          onClick={() => {
            clear();
            void run(onPrepare, ({ attemptId }) =>
              onAttempt({
                attemptId,
                amountMinor,
                state: "prepared",
                reference: null,
                approvalCode: null,
              }),
            );
          }}
        >
          <Icon name="credit-card" />
          Charge Rs {money(amountMinor)} on the card machine
        </button>
        <p className={ui.muted}>
          This is saved first, so the payment can&apos;t be taken twice. The
          sale can&apos;t change until the card is settled.
        </p>
        <ErrorLine error={error} />
      </div>
    );

  if (attempt.state === "approved")
    return (
      <div className={styles.card}>
        <div className={cx(ui.note)} role="status">
          <Icon name="check-circle" />
          <div>
            <b>Card approved · Rs {money(attempt.amountMinor)}</b>
            <div>
              Ref {attempt.reference} · code {attempt.approvalCode}
            </div>
          </div>
        </div>
        {form === "not_used" ? (
          <form
            className={styles.cardForm}
            onSubmit={(event) => {
              event.preventDefault();
              record({
                kind: "not_used",
                settlement,
                reversalReference:
                  settlement === "reversed_on_machine"
                    ? reference.trim() || null
                    : null,
                reason: reason.trim(),
              });
            }}
          >
            <b>Not used for this sale</b>
            <label className={styles.radio}>
              <input
                type="radio"
                checked={settlement === "reversed_on_machine"}
                onChange={() => setSettlement("reversed_on_machine")}
              />
              Reversed on the card machine
            </label>
            {settlement === "reversed_on_machine" && (
              <input
                className={ui.in}
                aria-label="Reversal reference"
                placeholder="Reversal slip reference"
                value={reference}
                maxLength={64}
                onChange={(e) => setReference(e.target.value)}
              />
            )}
            <label className={styles.radio}>
              <input
                type="radio"
                checked={settlement === "refund_owed"}
                onChange={() => setSettlement("refund_owed")}
              />
              The customer is owed a refund
            </label>
            <input
              className={ui.in}
              aria-label="Why it wasn't used"
              placeholder="Why it wasn't used"
              value={reason}
              maxLength={500}
              onChange={(e) => setReason(e.target.value)}
            />
            <div className={styles.cardBtns}>
              <button
                type="button"
                className={cx(ui.btn, ui.ghost)}
                onClick={() => setForm(null)}
              >
                Back
              </button>
              <button
                type="submit"
                className={cx(ui.btn, ui.primary)}
                disabled={
                  busy ||
                  !reason.trim() ||
                  (settlement === "reversed_on_machine" && !reference.trim())
                }
              >
                Record as not used
              </button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            className={cx(ui.btn, ui.ghost)}
            onClick={() => {
              setReference("");
              setReason("");
              setForm("not_used");
            }}
          >
            Card not used for this sale…
          </button>
        )}
        <ErrorLine error={error} />
      </div>
    );

  // Prepared, or not sure: the cashier says what the machine did.
  return (
    <div className={styles.card}>
      <div
        className={cx(ui.note, attempt.state === "uncertain" && ui.noteWarn)}
        role="status"
      >
        <Icon
          name={
            attempt.state === "uncertain" ? "alert-triangle" : "credit-card"
          }
        />
        <div>
          {attempt.state === "uncertain" ? (
            <>
              <b>Check the card machine before charging again</b>
              <div>
                Look at its last transactions for Rs{" "}
                {money(attempt.amountMinor)}, then record what it shows.
              </div>
            </>
          ) : (
            <>
              <b>
                Charge Rs {money(attempt.amountMinor)} on the card machine now
              </b>
              <div>Then record what the machine said.</div>
            </>
          )}
        </div>
      </div>
      {form === "approved" ? (
        <form
          className={styles.cardForm}
          onSubmit={(event) => {
            event.preventDefault();
            const approvedAt = slipTime(at);
            if (!approvedAt) return;
            record(
              {
                kind: "approved",
                reference: reference.trim(),
                approvalCode: code.trim(),
                approvedAt,
              },
              { reference: reference.trim(), approvalCode: code.trim() },
            );
          }}
        >
          <input
            className={ui.in}
            aria-label="Slip reference"
            placeholder="Reference on the slip"
            value={reference}
            maxLength={64}
            autoFocus
            onChange={(e) => setReference(e.target.value)}
          />
          <input
            className={ui.in}
            aria-label="Approval code"
            placeholder="Approval code"
            value={code}
            maxLength={32}
            onChange={(e) => setCode(e.target.value)}
          />
          <input
            className={ui.in}
            aria-label="Time on the slip"
            value={at}
            maxLength={5}
            onChange={(e) => setAt(e.target.value)}
          />
          <div className={styles.cardBtns}>
            <button
              type="button"
              className={cx(ui.btn, ui.ghost)}
              onClick={() => setForm(null)}
            >
              Back
            </button>
            <button
              type="submit"
              className={cx(ui.btn, ui.primary)}
              disabled={
                busy || !reference.trim() || !code.trim() || !slipTime(at)
              }
            >
              Record approval
            </button>
          </div>
        </form>
      ) : form === "declined" ? (
        <form
          className={styles.cardForm}
          onSubmit={(event) => {
            event.preventDefault();
            record(
              { kind: "declined", reference: reference.trim() },
              { reference: reference.trim() },
            );
          }}
        >
          <input
            className={ui.in}
            aria-label="Slip reference"
            placeholder="Reference on the declined slip"
            value={reference}
            maxLength={64}
            autoFocus
            onChange={(e) => setReference(e.target.value)}
          />
          <div className={styles.cardBtns}>
            <button
              type="button"
              className={cx(ui.btn, ui.ghost)}
              onClick={() => setForm(null)}
            >
              Back
            </button>
            <button
              type="submit"
              className={cx(ui.btn, ui.primary)}
              disabled={busy || !reference.trim()}
            >
              Record decline
            </button>
          </div>
        </form>
      ) : (
        <div className={styles.cardBtns}>
          <button
            type="button"
            className={cx(ui.btn, ui.primary)}
            onClick={() => {
              setReference("");
              setCode("");
              setAt(hhmm(new Date()));
              setForm("approved");
            }}
            disabled={busy}
          >
            Approved
          </button>
          <button
            type="button"
            className={cx(ui.btn, ui.outline)}
            onClick={() => {
              setReference("");
              setForm("declined");
            }}
            disabled={busy}
          >
            Declined
          </button>
          {attempt.state === "prepared" && (
            <button
              type="button"
              className={cx(ui.btn, ui.ghost)}
              onClick={() => record({ kind: "not_sure" })}
              disabled={busy}
            >
              Not sure
            </button>
          )}
          <button
            type="button"
            className={cx(ui.btn, ui.ghost)}
            onClick={() =>
              record({ kind: "never_charged" }, { reference: null })
            }
            disabled={busy}
          >
            Never reached the machine
          </button>
        </div>
      )}
      <ErrorLine error={error} />
    </div>
  );
}
