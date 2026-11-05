import { useRef, useState, type FormEvent, type ReactNode } from "react";
import type {
  DeviceState,
  LocalShift,
  ShiftState,
} from "../../shared/ipc-contract";
import {
  DRAWER_ROWS,
  drawerCount,
  rowAmountMinor,
  rowCount,
  type DrawerEntry,
} from "./cash-count";
import styles from "./CashShift.module.css";
import shell from "./Shell.module.css";
import { shortName, time } from "./format";
import { Icon } from "./Icon";
import { KeyHint } from "./KeyHint";
import { clickSubmit, useKeyBinding } from "./keymap";
import { money } from "./sell-model";
import { Avatar } from "./Shell";
import ui from "./ui.module.css";
import { cx, ErrorLine, useAction } from "./useAction";

const TONE: Record<string, string> = {
  violet: "var(--pos-t-violet)",
  indigo: "var(--pos-t-indigo)",
  blue: "var(--pos-t-blue)",
  amber: "var(--pos-t-amber)",
  rose: "var(--pos-t-rose)",
  emerald: "var(--pos-t-emerald)",
  cyan: "var(--pos-t-cyan)",
  teal: "var(--pos-t-teal)",
};

const shiftName = (shift: Pick<LocalShift, "shiftNumber">) =>
  shift.shiftNumber ? `Shift ${shift.shiftNumber}` : "Shift";

/** "6 h 30 min so far". */
function soFar(since: string, now = Date.now()) {
  const minutes = Math.max(0, Math.round((now - new Date(since).getTime()) / 60_000));
  const h = Math.floor(minutes / 60);
  return h ? `${h} h ${minutes % 60} min so far` : `${minutes} min so far`;
}

/** Whether the server has the latest step, said the way the mockup does. */
export function SyncPill({ shift }: { shift: LocalShift }) {
  if (shift.sync === "synced")
    return (
      <span className={cx(ui.pill, ui.ok)}>
        <Icon name="check" />
        Synced{shift.summaryAt ? ` ${time(new Date(shift.summaryAt))}` : ""}
      </span>
    );
  if (shift.sync === "failed")
    return (
      <span className={cx(ui.pill, ui.bad)}>
        <Icon name="alert-triangle" />
        Not saved on the server
      </span>
    );
  return (
    <span className={cx(ui.pill, ui.warn)}>
      <Icon name="refresh" />
      Not yet synced
    </span>
  );
}

/**
 * Counting the drawer by note and coin; the app adds them up. Used to open a shift and to close
 * one. `entry` is what's typed per row.
 */
export function DrawerTable({
  entry,
  onChange,
  disabled,
  autoFocus,
}: {
  entry: DrawerEntry;
  onChange: (entry: DrawerEntry) => void;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const [focused, setFocused] = useState<string | null>(null);
  return (
    <div className={styles.den} role="group" aria-label="Count the drawer">
      <div className={cx(styles.denRow, styles.denHead)} aria-hidden="true">
        <span>Note or coin</span>
        <span />
        <span className={styles.c}>Count</span>
        <span className={styles.r}>Amount</span>
      </div>
      {DRAWER_ROWS.map((row, i) => {
        const raw = entry[row.key] ?? "";
        const bad = rowCount(raw) === null;
        return (
          <label
            key={row.key}
            className={cx(styles.denRow, focused === row.key && styles.sel)}
            style={{ ["--c" as string]: TONE[row.tone] }}
          >
            <span className={styles.nv}>
              <i className={cx(row.coin && styles.coin)} aria-hidden="true" />
              {row.label}
            </span>
            <span className={styles.x} aria-hidden="true">
              {row.coin ? "" : "×"}
            </span>
            <input
              className={cx(styles.cell, bad && styles.cellBad)}
              inputMode="numeric"
              autoComplete="off"
              aria-label={row.coin ? "Coins, in rupees" : `Number of ${row.label} notes`}
              aria-invalid={bad || undefined}
              value={raw}
              disabled={disabled}
              autoFocus={autoFocus && i === 0}
              placeholder="0"
              onFocus={() => setFocused(row.key)}
              onBlur={() => setFocused((current) => (current === row.key ? null : current))}
              onChange={(event) =>
                onChange({ ...entry, [row.key]: event.target.value.replace(/[^\d]/g, "").slice(0, 6) })
              }
            />
            <span className={styles.am}>{money(rowAmountMinor(row, raw))}</span>
          </label>
        );
      })}
    </div>
  );
}

/** The shift open on this till: who, since when, and the drawer's figures. */
export function ShiftCard({
  shift,
  actions,
}: {
  shift: LocalShift;
  actions?: ReactNode;
}) {
  const summary = shift.summary;
  const paidOut = summary ? summary.cashRefundsMinor + summary.cashPaidOutMinor : null;
  const cashSales = summary?.takingsByMethod.find((m) => m.method === "cash")?.saleCount ?? 0;
  const refunds = summary?.refunds.filter((r) => r.paidBack.some((p) => p.method === "cash")).length ?? 0;
  const payouts = summary?.cashMovements.filter((m) => m.direction === "out").length ?? 0;
  return (
    <div className={cx(ui.panel, styles.shiftCard)}>
      <div className={styles.shiftH}>
        <Avatar id={shift.staffUserId} name={shift.staffName} />
        <div>
          <b>
            {shiftName(shift)} · {shift.staffName}
          </b>
          <small>
            Opened {time(new Date(shift.openedAt))} with Rs {money(shift.openingCashMinor)} counted ·{" "}
            {soFar(shift.openedAt)}
          </small>
        </div>
        <div className={styles.right}>
          <SyncPill shift={shift} />
          {actions}
        </div>
      </div>
      <div className={cx(ui.tiles, styles.tiles)}>
        <div className={ui.tile}>
          <small>Opening cash</small>
          <b>{money(shift.openingCashMinor)}</b>
          <span>
            Counted by {shortName(shift.staffName).split(" ")[0]}, {time(new Date(shift.openedAt))}
          </span>
        </div>
        <div className={ui.tile}>
          <small>Cash taken</small>
          <b>{summary ? `+${money(summary.cashTakenMinor - summary.changeGivenMinor)}` : "—"}</b>
          <span>
            {cashSales} cash {cashSales === 1 ? "sale" : "sales"}
          </span>
        </div>
        <div className={ui.tile}>
          <small>Cash paid out</small>
          <b>{paidOut === null ? "—" : paidOut ? `−${money(paidOut)}` : money(0)}</b>
          <span>
            {[
              `${refunds} ${refunds === 1 ? "refund" : "refunds"}`,
              ...(payouts ? [`${payouts} supplier ${payouts === 1 ? "payout" : "payouts"}`] : []),
            ].join(" · ")}
          </span>
        </div>
        <div className={cx(ui.tile, styles.main)}>
          <small>Expected in drawer</small>
          <b>{money(shift.expectedCashMinor)}</b>
          <span>What the count should show</span>
        </div>
      </div>
    </div>
  );
}

/** Opening your own shift: count what's in the drawer, then your PIN. */
function OpenShift({
  lastClosed,
  onShift,
}: {
  lastClosed: LocalShift | null;
  onShift: (state: ShiftState) => void;
}) {
  const [entry, setEntry] = useState<DrawerEntry>({});
  const [pin, setPin] = useState("");
  const form = useRef<HTMLFormElement>(null);
  const { busy, error, run } = useAction();
  const count = drawerCount(entry);
  const ready = Boolean(count) && /^\d{4,8}$/.test(pin) && !busy;
  useKeyBinding("Ctrl+Enter", () => clickSubmit(form.current), { enabled: ready });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!count || !ready) return;
    const entered = pin;
    setPin("");
    void run(() => window.pos.openShift({ pin: entered, count }), onShift);
  }

  const handedOver = lastClosed?.closingCashCountMinor ?? null;
  const differs = count && handedOver !== null && count.totalMinor !== handedOver;
  return (
    <form ref={form} className={cx(ui.panel, styles.count)} onSubmit={submit}>
      <div className={styles.cntH}>
        <div className={ui.eyebrow}>Open your shift</div>
        <h2>Count the drawer</h2>
        <p>Count every note and coin you start with. It&apos;s your shift&apos;s opening cash.</p>
      </div>
      <DrawerTable entry={entry} onChange={setEntry} disabled={busy} autoFocus />
      <div className={styles.tot3}>
        <div>
          <small>Counted</small>
          <b>{count ? money(count.totalMinor) : "—"}</b>
        </div>
        <div>
          <small>Left by the last close</small>
          <b>{handedOver === null ? "—" : money(handedOver)}</b>
        </div>
        <div className={cx(differs && styles.short)}>
          <small>Difference</small>
          <b>
            {count && handedOver !== null
              ? `${count.totalMinor - handedOver < 0 ? "−" : count.totalMinor > handedOver ? "+" : ""}${money(Math.abs(count.totalMinor - handedOver))}`
              : "—"}
          </b>
        </div>
      </div>
      <div className={cx(ui.f, styles.field)}>
        <label htmlFor="shift-pin">Your PIN</label>
        <input
          id="shift-pin"
          className={ui.in}
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={8}
          value={pin}
          disabled={busy}
          onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 8))}
        />
      </div>
      <div className={styles.offl}>
        <Icon name="info" />
        <span>
          A different count from the last close is fine: both stay on record.
        </span>
      </div>
      <div className={styles.err}>
        <ErrorLine error={error} />
      </div>
      <div className={ui.dfoot}>
        <span className={ui.grow} />
        <button type="submit" className={cx(ui.btn, ui.primary, ui.lg)} disabled={!ready}>
          <Icon name="wallet" />
          Open my shift
          <KeyHint keys="Ctrl+Enter" onPrimary small />
        </button>
      </div>
    </form>
  );
}

/** The last shift closed on this till, for whoever opens the next one. */
function LastClose({ shift }: { shift: LocalShift }) {
  const variance = shift.varianceMinor;
  return (
    <div className={cx(ui.panel, styles.lastClose)}>
      <div className={ui.ph}>
        <h2>Last close on this till</h2>
        <span className={ui.grow} />
        <SyncPill shift={shift} />
      </div>
      <div className={styles.kv}>
        <div>
          <span>{shiftName(shift)}</span>
          <b>{shift.staffName}</b>
        </div>
        <div>
          <span>Closed</span>
          <b>
            {shift.closedAt ? time(new Date(shift.closedAt)) : "—"}
            {shift.closedByName && shift.closedByName !== shift.staffName
              ? ` by ${shift.closedByName}`
              : ""}
          </b>
        </div>
        <div>
          <span>Counted</span>
          <b>{shift.closingCashCountMinor === null ? "—" : `Rs ${money(shift.closingCashCountMinor)}`}</b>
        </div>
        <div>
          <span>Difference</span>
          <b className={cx(variance !== null && variance < 0 && styles.neg)}>
            {variance === null
              ? "Not confirmed yet"
              : variance === 0
                ? "None"
                : `${variance < 0 ? "Short" : "Over"} Rs ${money(Math.abs(variance))}`}
          </b>
        </div>
        {shift.varianceNote && (
          <div>
            <span>Note</span>
            <b>{shift.varianceNote}</b>
          </div>
        )}
        {shift.assistanceReason && (
          <div>
            <span>Closed for them</span>
            <b>{shift.assistanceReason}</b>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Cash & shift (mockup screen=cash). One shift is open on this till at a time; each person counts
 * the drawer when they start and finish. `closePanel` and `details` are where closing and the
 * shift's takings go.
 */
export function CashShiftPage({
  device,
  shift,
  onShift,
  closePanel,
  details,
  cardActions,
}: {
  device: DeviceState;
  shift: ShiftState | null;
  onShift: (state: ShiftState) => void;
  closePanel?: ReactNode;
  details?: ReactNode;
  cardActions?: ReactNode;
}) {
  const me = device.staffSession?.staffUserId;
  const current = shift?.current ?? null;
  const counter = device.enrollment?.counterLabel ?? "this counter";
  const mine = current && current.staffUserId === me;
  return (
    <div className={styles.page}>
      <div className={ui.pageH}>
        <div>
          <h1>Cash &amp; shift</h1>
          <p>
            The till at {counter}. One shift is open on this till at a time; each person counts the
            cash when they start and finish.
          </p>
        </div>
      </div>
      <div className={styles.body}>
        <div className={styles.left}>
          {current && current.status !== "opening" ? (
            <ShiftCard shift={current} actions={cardActions} />
          ) : (
            <div className={cx(ui.panel, styles.empty)}>
              <span className={cx(ui.kind, styles.emptyIcon)}>
                <Icon name="wallet" />
              </span>
              <div>
                <b>
                  {current?.status === "opening"
                    ? "Your shift's opening isn't confirmed yet"
                    : "No shift is open on this till"}
                </b>
                <small>
                  {current?.status === "opening"
                    ? "The server didn't answer. The counter checks again; open it again only if it's still not open."
                    : "Selling starts when someone opens their shift with a cash count and their PIN."}
                </small>
              </div>
            </div>
          )}
          {current && !mine && current.status !== "opening" && (
            <div className={cx(ui.note, current.status === "closing" && ui.noteWarn)}>
              <Icon name={current.status === "closing" ? "alert-triangle" : "info"} />
              <div>
                {current.status === "closing" ? (
                  <>
                    <b>{shiftName(current)}&apos;s close is saved here, not yet synced.</b> It&apos;s sent
                    again when {current.closedByName ?? current.staffName} signs in.
                  </>
                ) : (
                  <>
                    <b>
                      {shiftName(current)} is {current.staffName}&apos;s.
                    </b>{" "}
                    They count the drawer and close it before you open yours. If they aren&apos;t here,
                    a manager closes it for them.
                  </>
                )}
              </div>
            </div>
          )}
          {details}
          {!current && shift?.lastClosed && <LastClose shift={shift.lastClosed} />}
        </div>
        {!current || current.status === "opening" ? (
          <OpenShift lastClosed={shift?.lastClosed ?? null} onShift={onShift} />
        ) : (
          closePanel ?? null
        )}
      </div>
    </div>
  );
}

/**
 * Covers Sell while there's no open shift on this till for the person signed in. The sale on the
 * page underneath is kept. Selling needs an open shift on this till.
 */
export function ShiftGate({
  device,
  shift,
  onOpen,
}: {
  device: DeviceState;
  shift: ShiftState;
  onOpen: () => void;
}) {
  const me = device.staffSession?.staffUserId;
  const current = shift.current;
  if (current && current.status === "open" && current.staffUserId === me) return null;
  let title: string;
  let text: string;
  if (!current || current.status === "opening") {
    title = current ? "Your shift's opening isn't confirmed yet" : "Open your shift to start selling";
    text = current
      ? "The server didn't answer when the shift opened. Check it on Cash & shift."
      : "Count the drawer and enter your PIN on Cash & shift. Every sale goes on your shift.";
  } else if (current.status === "closing") {
    title = `${shiftName(current)} is closing`;
    text = "Its close is saved on this counter and not yet confirmed. Selling starts again when a new shift is open.";
  } else {
    title = `${current.staffName}'s shift is open on this till`;
    text = `${current.staffName.split(" ")[0]} continues it. To sell, they count the drawer and close it first, then you open your own. If they aren't here, a manager closes it for them.`;
  }
  return (
    <div className={shell.block} role="alert">
      <div className={cx(ui.panel, shell.blockCard)}>
        <span className={cx(ui.kind, shell.blockIcon)}>
          <Icon name="wallet" />
        </span>
        <h2>{title}</h2>
        <p>{text}</p>
        <button type="button" className={cx(ui.btn, ui.primary, ui.lg)} onClick={onOpen}>
          <Icon name="wallet" />
          Go to Cash &amp; shift
        </button>
      </div>
    </div>
  );
}
