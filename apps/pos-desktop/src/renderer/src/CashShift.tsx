import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type {
  DeviceState,
  LocalShift,
  PastShift,
  Printer,
  ShiftState,
  ShiftSummary,
} from "../../shared/ipc-contract";
import {
  counted,
  describeCount,
  DRAWER_ROWS,
  drawerCount,
  rowAmountMinor,
  rowCount,
  type DrawerEntry,
} from "./cash-count";
import styles from "./CashShift.module.css";
import shell from "./Shell.module.css";
import { shortName, time } from "./format";
import { Icon, type IconName } from "./Icon";
import { KeyHint } from "./KeyHint";
import { clickSubmit, useKeyBinding } from "./keymap";
import { money } from "./sell-model";
import { Avatar } from "./Shell";
import { ROLE_LABELS } from "./SignIn";
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

const roleLabel = (role: string | null | undefined) => (role ? (ROLE_LABELS[role] ?? role) : null);

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
  role,
  actions,
}: {
  shift: LocalShift;
  /** The shift owner's role at this counter, as the lock screen shows it. */
  role?: string | null;
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
            {role ? `${role} · opened` : "Opened"} {time(new Date(shift.openedAt))} with Rs{" "}
            {money(shift.openingCashMinor)} counted · {soFar(shift.openedAt)}
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
  const count = counted(entry) ? drawerCount(entry) : null;
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
          <small>Last close</small>
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

const METHODS: Record<string, { label: string; icon: IconName; tone: string; note?: string }> = {
  cash: { label: "Cash", icon: "banknote", tone: "emerald" },
  card: { label: "Card", icon: "credit-card", tone: "blue" },
  mobile_wallet: { label: "Mobile wallet", icon: "smartphone", tone: "violet" },
  credit: { label: "On account", icon: "user", tone: "amber", note: "Customer credit" },
};
const method = (key: string) => METHODS[key] ?? { label: key, icon: "receipt" as IconName, tone: "teal" };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const itemsText = (items: ShiftSummary["refunds"][number]["items"]) =>
  items.map((item) => `${item.name}${item.qty > 1 ? ` × ${item.qty}` : ""}`).join(", ");

/** Takings this shift: by how it was paid (with refunds), or by the branch's clock hour. */
function Takings({ summary }: { summary: ShiftSummary | null }) {
  const [byHour, setByHour] = useState(false);
  return (
    <div className={ui.panel}>
      <div className={ui.ph}>
        <h2>Takings this shift</h2>
        <span className={ui.grow} />
        <button
          type="button"
          className={cx(ui.btn, ui.ghost, ui.sm)}
          aria-pressed={byHour}
          onClick={() => setByHour((v) => !v)}
        >
          {byHour ? "By payment" : "By hour"}
        </button>
      </div>
      {!summary ? (
        <p className={styles.wait}>The figures come from the server once it answers.</p>
      ) : byHour ? (
        <div className={styles.pm}>
          {summary.takingsByHour.length === 0 && <p className={styles.wait}>No sales yet.</p>}
          {summary.takingsByHour.map((h) => {
            const top = Math.max(...summary.takingsByHour.map((x) => x.totalMinor), 1);
            const hour = Number(h.hour.slice(11, 13));
            return (
              <div key={h.hour} className={cx(styles.pmRow, styles.hourRow)}>
                <span className={styles.hour}>
                  {String(hour).padStart(2, "0")}:00
                </span>
                <span className={styles.bar} aria-hidden="true">
                  <i style={{ width: `${Math.max(2, (h.totalMinor / top) * 100)}%` }} />
                </span>
                <span className={styles.n}>{plural(h.saleCount, "sale")}</span>
                <span className={styles.a}>{money(h.totalMinor)}</span>
              </div>
            );
          })}
        </div>
      ) : (
        <>
          <div className={styles.pm}>
            {summary.takingsByMethod.map((m) => {
              const look = method(m.method);
              return (
                <div key={m.method} className={styles.pmRow}>
                  <span className={styles.qi} style={{ ["--c" as string]: TONE[look.tone] }}>
                    <Icon name={look.icon} />
                  </span>
                  <div>
                    <b>{look.label}</b>
                    {look.note && <small>{look.note}</small>}
                  </div>
                  <span className={styles.n}>{plural(m.saleCount, "sale")}</span>
                  <span className={styles.a}>{money(m.takenMinor)}</span>
                </div>
              );
            })}
            <div className={cx(styles.pmRow, styles.tot)}>
              <span />
              <b>Sales</b>
              <span className={styles.n}>{plural(summary.saleCount, "sale")}</span>
              <span className={styles.a}>{money(summary.salesTotalMinor)}</span>
            </div>
          </div>
          {summary.refunds.length > 0 && (
            <>
              <div className={styles.pmSub}>Refunds</div>
              <div className={styles.pm}>
                {summary.refunds.map((r, i) => {
                  const look = method(r.paidBack[0]?.method ?? "cash");
                  return (
                    <div
                      key={r.goodsReturnId}
                      className={cx(styles.pmRow, i === summary.refunds.length - 1 && styles.last)}
                    >
                      <span className={styles.qi} style={{ ["--c" as string]: TONE.rose }}>
                        <Icon name={look.icon} />
                      </span>
                      <div>
                        <b>{r.paidBack.map((p) => method(p.method).label).join(" + ") || look.label}</b>
                        <small>
                          {r.returnNumber}
                          {r.items.length ? ` · ${itemsText(r.items)}` : ""}
                        </small>
                      </div>
                      <span className={styles.n}>1</span>
                      <span className={cx(styles.a, styles.neg)}>−{money(r.amountMinor)}</span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

/** Every movement of cash in and out of the drawer this shift. */
function CashLog({ shift }: { shift: LocalShift }) {
  const summary = shift.summary;
  const cashRefunds =
    summary?.refunds.filter((r) => r.paidBack.some((p) => p.method === "cash")) ?? [];
  const cashSales = summary?.takingsByMethod.find((m) => m.method === "cash");
  const net = summary ? summary.cashTakenMinor - summary.changeGivenMinor : 0;
  return (
    <div className={ui.panel}>
      <div className={ui.ph}>
        <h2>Cash in and out of the drawer</h2>
      </div>
      <div className={styles.log}>
        <div className={styles.lgr}>
          <span className={styles.qi} style={{ ["--c" as string]: TONE.teal }}>
            <Icon name="wallet" />
          </span>
          <div>
            <b>Opening count</b>
            <small>
              {time(new Date(shift.openedAt))} · {shortName(shift.staffName)}
              {shift.openingCount.length ? ` · ${describeCount(shift.openingCount)}` : ""}
            </small>
          </div>
          <span className={styles.a}>{money(shift.openingCashMinor)}</span>
        </div>
        {summary?.cashMovements.map((m) => (
          <div key={m.id} className={styles.lgr}>
            <span
              className={styles.qi}
              style={{ ["--c" as string]: m.direction === "out" ? TONE.indigo : TONE.emerald }}
            >
              <Icon name={m.referenceType === "supplier_payment" ? "truck" : "wallet"} />
            </span>
            <div>
              <b>{m.reason}</b>
              <small>
                {time(new Date(m.at))}
                {m.recordedBy ? ` · ${shortName(m.recordedBy.fullName)}` : ""}
              </small>
            </div>
            <span className={cx(styles.a, m.direction === "out" ? styles.neg : styles.pos)}>
              {m.direction === "out" ? "−" : "+"}
              {money(m.amountMinor)}
            </span>
          </div>
        ))}
        {cashRefunds.map((r) => (
          <div key={r.goodsReturnId} className={styles.lgr}>
            <span className={styles.qi} style={{ ["--c" as string]: TONE.rose }}>
              <Icon name="rotate-ccw" />
            </span>
            <div>
              <b>Cash refund · {r.returnNumber}</b>
              <small>
                {time(new Date(r.at))}
                {r.processedBy ? ` · ${shortName(r.processedBy.fullName)}` : ""}
                {r.items.length
                  ? r.items.every((item) => item.disposition === "quarantine")
                    ? " · held for inspection"
                    : " · back on the shelf"
                  : ""}
              </small>
            </div>
            <span className={cx(styles.a, styles.neg)}>
              −{money(r.paidBack.filter((p) => p.method === "cash").reduce((n, p) => n + p.amountMinor, 0))}
            </span>
          </div>
        ))}
        {summary && cashSales && (
          <div className={styles.lgr}>
            <span className={styles.qi} style={{ ["--c" as string]: TONE.emerald }}>
              <Icon name="banknote" />
            </span>
            <div>
              <b>Cash sales</b>
              <small>
                {summary.firstSaleAt && summary.lastSaleAt
                  ? `${time(new Date(summary.firstSaleAt))} to ${time(new Date(summary.lastSaleAt))} · `
                  : ""}
                {plural(cashSales.saleCount, "sale")}, change given
              </small>
            </div>
            <span className={cx(styles.a, styles.pos)}>+{money(net)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

const signed = (minor: number) => `${minor < 0 ? "−" : minor > 0 ? "+" : ""}${money(Math.abs(minor))}`;

/**
 * Closing the open shift by counting the drawer. The shift's own person hands over (the counter
 * locks for the next person) or closes for the day; anyone else is a manager closing it for them,
 * with their own PIN and a reason. A close the server hasn't confirmed waits here, saved.
 */
function ClosePanel({
  device,
  shift,
  onShift,
  onHandover,
}: {
  device: DeviceState;
  shift: LocalShift;
  onShift: (state: ShiftState) => void;
  onHandover: (nextStaffUserId: string | null) => void;
}) {
  const me = device.staffSession?.staffUserId;
  const mine = shift.staffUserId === me;
  const [entry, setEntry] = useState<DrawerEntry>({});
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [pin, setPin] = useState("");
  const others = device.counterStaff.filter((p) => p.staffUserId !== me && p.state === "ready");
  const [next, setNext] = useState<string>("");
  const form = useRef<HTMLFormElement>(null);
  const { busy, error, run } = useAction();
  const count = counted(entry) ? drawerCount(entry) : null;
  const expected = shift.expectedCashMinor;
  const variance = count ? count.totalMinor - expected : null;
  const pinOk = /^\d{4,8}$/.test(pin);
  const ready = Boolean(count) && !busy && (mine || (pinOk && reason.trim() !== ""));
  const nextPerson = others.find((p) => p.staffUserId === next) ?? null;

  function close(handover: boolean) {
    if (!count || !ready) return;
    const entered = pin;
    setPin("");
    void run(
      () =>
        window.pos.closeShift({
          count,
          ...(note.trim() ? { varianceNote: note.trim() } : {}),
          ...(mine ? {} : { assistance: { pin: entered, reason: reason.trim() } }),
        }),
      (state) => {
        onShift(state);
        if (handover) onHandover(nextPerson?.staffUserId ?? null);
      },
    );
  }
  useKeyBinding("Ctrl+Enter", () => close(true), { enabled: ready && shift.status === "open" });

  if (shift.status === "closing") return <PendingClose device={device} shift={shift} onShift={onShift} />;

  return (
    <form
      ref={form}
      className={cx(ui.panel, styles.count)}
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        close(true);
      }}
    >
      <div className={styles.cntH}>
        <div className={ui.eyebrow}>
          Close {shift.shiftNumber ? `shift ${shift.shiftNumber}` : "this shift"}
          {mine ? "" : ` for ${shift.staffName.split(" ")[0]}`}
        </div>
        <h2>Count the drawer</h2>
        <p>
          Count every note and coin. Any difference stays on record, even if the next person counts
          something else.
        </p>
      </div>
      {shift.error && shift.sync === "failed" && (
        <div className={cx(ui.note, ui.noteBad, styles.inset)} role="alert">
          <Icon name="alert-triangle" />
          <div>
            <b>The last close didn&apos;t go through.</b> {shift.error.message}
          </div>
        </div>
      )}
      <DrawerTable entry={entry} onChange={setEntry} disabled={busy} />
      <div className={styles.tot3}>
        <div>
          <small>Counted</small>
          <b>{count ? money(count.totalMinor) : "—"}</b>
        </div>
        <div>
          <small>Expected</small>
          <b>{money(expected)}</b>
        </div>
        <div className={cx(variance !== null && variance < 0 && styles.short, variance !== null && variance > 0 && styles.over)}>
          <small>{variance === null || variance === 0 ? "Difference" : variance < 0 ? "Short" : "Over"}</small>
          <b>{variance === null ? "—" : signed(variance)}</b>
        </div>
      </div>
      <div className={cx(ui.f, styles.field)}>
        <label htmlFor="close-note">Note on the difference</label>
        <input
          id="close-note"
          className={ui.in}
          maxLength={500}
          value={note}
          placeholder={variance ? "What might explain it" : "Optional"}
          disabled={busy}
          onChange={(event) => setNote(event.target.value)}
        />
      </div>
      {mine ? (
        others.length > 0 && (
          <label className={styles.ho}>
            {nextPerson ? (
              <Avatar id={nextPerson.staffUserId} name={nextPerson.staffName} />
            ) : (
              <span className={styles.hoIcon}>
                <Icon name="users" />
              </span>
            )}
            <div>
              <b>{nextPerson ? `Next: ${nextPerson.staffName}` : "Next: whoever signs in"}</b>
              <small>Opens their own shift and counts the drawer with their PIN</small>
            </div>
            <Icon name="chevron-down" />
            <select
              aria-label="Who takes over next"
              value={next}
              disabled={busy}
              onChange={(event) => setNext(event.target.value)}
            >
              <option value="">Whoever signs in</option>
              {others.map((p) => (
                <option key={p.staffUserId} value={p.staffUserId}>
                  {p.staffName}
                </option>
              ))}
            </select>
          </label>
        )
      ) : (
        <>
          <div className={cx(ui.f, styles.field)}>
            <label htmlFor="close-reason">Why you&apos;re closing it for them</label>
            <input
              id="close-reason"
              className={ui.in}
              maxLength={500}
              value={reason}
              placeholder={`${shift.staffName.split(" ")[0]} isn't at the counter`}
              disabled={busy}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          <div className={cx(ui.f, styles.field)}>
            <label htmlFor="close-pin">Your PIN</label>
            <input
              id="close-pin"
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
        </>
      )}
      <div className={styles.offl}>
        <Icon name="info" />
        <span>
          {mine
            ? "The close is saved on this counter first and shows \"not yet synced\" until the server confirms it."
            : `${shift.staffName} stays on the record as the shift's owner, and you as the person who closed it.`}
        </span>
      </div>
      <div className={styles.err}>
        <ErrorLine error={error} />
      </div>
      <div className={ui.dfoot}>
        {mine && (
          <button
            type="button"
            className={cx(ui.btn, ui.ghost, ui.lg)}
            disabled={!ready}
            onClick={() => close(false)}
          >
            End of day
          </button>
        )}
        <span className={ui.grow} />
        <button type="submit" className={cx(ui.btn, ui.primary, ui.lg)} disabled={!ready}>
          <Icon name="lock" />
          {mine ? "Close shift and hand over" : "Close their shift"}
          <KeyHint keys="Ctrl+Enter" onPrimary small />
        </button>
      </div>
    </form>
  );
}

/** A close saved here that the server hasn't confirmed: it's sent again, never lost. */
function PendingClose({
  device,
  shift,
  onShift,
}: {
  device: DeviceState;
  shift: LocalShift;
  onShift: (state: ShiftState) => void;
}) {
  const [pin, setPin] = useState("");
  const { busy, error, run } = useAction();
  const closer = shift.closedByName ?? shift.staffName;
  const canSend = device.staffSession?.staffName === closer;
  const variance = shift.closingCashCountMinor === null ? null : shift.closingCashCountMinor - shift.expectedCashMinor;
  return (
    <div className={cx(ui.panel, styles.count)}>
      <div className={styles.cntH}>
        <div className={ui.eyebrow}>Close {shift.shiftNumber ? `shift ${shift.shiftNumber}` : "this shift"}</div>
        <h2>Saved, not yet synced</h2>
        <p>
          {closer} counted the drawer and closed this shift on this counter. The server hasn&apos;t
          confirmed it yet; nothing is lost if the app restarts.
        </p>
      </div>
      <div className={styles.tot3}>
        <div>
          <small>Counted</small>
          <b>{shift.closingCashCountMinor === null ? "—" : money(shift.closingCashCountMinor)}</b>
        </div>
        <div>
          <small>Expected</small>
          <b>{money(shift.expectedCashMinor)}</b>
        </div>
        <div className={cx(variance !== null && variance < 0 && styles.short, variance !== null && variance > 0 && styles.over)}>
          <small>{!variance ? "Difference" : variance < 0 ? "Short" : "Over"}</small>
          <b>{variance === null ? "—" : signed(variance)}</b>
        </div>
      </div>
      {shift.error && (
        <div className={cx(ui.note, ui.noteWarn, styles.inset)}>
          <Icon name="alert-triangle" />
          <div>{shift.error.message}</div>
        </div>
      )}
      {canSend && shift.needsManagerPin && (
        <div className={cx(ui.f, styles.field)}>
          <label htmlFor="resend-pin">Your PIN, to send it again</label>
          <input
            id="resend-pin"
            className={ui.in}
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={8}
            value={pin}
            onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 8))}
          />
        </div>
      )}
      {!canSend && (
        <div className={cx(ui.note, styles.inset)}>
          <Icon name="info" />
          <div>It&apos;s sent again when {closer} signs in at this counter.</div>
        </div>
      )}
      <div className={styles.err}>
        <ErrorLine error={error} />
      </div>
      <div className={ui.dfoot}>
        <span className={ui.grow} />
        <button
          type="button"
          className={cx(ui.btn, ui.primary, ui.lg)}
          disabled={!canSend || busy || (shift.needsManagerPin && !/^\d{4,8}$/.test(pin))}
          onClick={() => {
            const entered = pin;
            setPin("");
            void run(() => window.pos.retryShiftClose(entered ? { pin: entered } : {}), onShift);
          }}
        >
          <Icon name="refresh" />
          Send the close again
        </button>
      </div>
    </div>
  );
}

/** Shifts on this till, newest first, from the server. */
function PastShifts({ active }: { active: boolean }) {
  const [rows, setRows] = useState<PastShift[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    let live = true;
    window.pos
      .listShifts()
      .then((result) => {
        if (!live) return;
        if (result.ok) setRows(result.value);
        else setError(result.error.message);
      })
      .catch(() => live && setError("The shifts couldn't be loaded. Try again."));
    return () => {
      live = false;
    };
  }, [active]);
  return (
    <div className={cx(ui.panel, styles.past)}>
      <div className={ui.ph}>
        <h2>Past shifts on this till</h2>
      </div>
      <ErrorLine error={error} />
      {rows === null && !error && <p className={styles.wait}>Loading…</p>}
      {rows?.length === 0 && <p className={styles.wait}>No shifts on this till yet.</p>}
      {rows && rows.length > 0 && (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Shift</th>
              <th>Who</th>
              <th>Opened</th>
              <th>Closed</th>
              <th className={styles.num}>Opening</th>
              <th className={styles.num}>Expected</th>
              <th className={styles.num}>Counted</th>
              <th className={styles.num}>Difference</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.workSessionId}>
                <td>
                  <b>{row.shiftNumber}</b>
                </td>
                <td>
                  {row.staffName}
                  {row.closeKind === "assisted" && (
                    <small>
                      Closed by {row.closedByName}: {row.assistanceReason}
                    </small>
                  )}
                  {row.varianceNote && <small>{row.varianceNote}</small>}
                </td>
                <td>{dayTime(row.openedAt)}</td>
                <td>{row.closedAt ? dayTime(row.closedAt) : <span className={cx(ui.pill, ui.brand)}>Open</span>}</td>
                <td className={styles.num}>{money(row.openingCashMinor)}</td>
                <td className={styles.num}>{row.expectedCashMinor === null ? "—" : money(row.expectedCashMinor)}</td>
                <td className={styles.num}>
                  {row.closingCashCountMinor === null ? "—" : money(row.closingCashCountMinor)}
                </td>
                <td className={cx(styles.num, row.varianceMinor !== null && row.varianceMinor < 0 && styles.neg)}>
                  {row.varianceMinor === null ? "—" : signed(row.varianceMinor)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const dayTime = (iso: string) => {
  const date = new Date(iso);
  return `${date.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} · ${time(date)}`;
};

/** Prints the X report: a mid-shift summary on the receipt printer. The shift stays open. */
function XReportButton({ printer }: { printer: Printer | null | undefined }) {
  const [state, setState] = useState<"idle" | "printing" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  async function print() {
    if (!printer) return;
    setState("printing");
    setError(null);
    try {
      const result = await window.pos.printXReport({ printerName: printer.name });
      if (!result.ok) setError(result.error.message);
      else if (!result.value.ok) setError(result.value.error ?? "The printer did not accept the job.");
      setState(result.ok && result.value.ok ? "done" : "idle");
    } catch {
      setError("Something went wrong. Please try again.");
      setState("idle");
    }
  }
  return (
    <>
      <button
        type="button"
        className={cx(ui.btn, ui.outline, ui.sm)}
        disabled={!printer || state === "printing"}
        title={printer ? `Prints on ${printer.displayName}` : "No printer installed"}
        onClick={() => void print()}
      >
        <Icon name="printer" />
        {state === "printing" ? "Printing…" : state === "done" ? "Printed" : "Print X report"}
      </button>
      {error && (
        <span role="alert" className={cx(ui.pill, ui.bad)}>
          {error}
        </span>
      )}
    </>
  );
}

/**
 * Cash & shift (mockup screen=cash). One shift is open on this till at a time; each person counts
 * the drawer when they start and finish.
 */
export function CashShiftPage({
  device,
  shift,
  onShift,
  printer,
  onHandover = () => undefined,
  active = true,
}: {
  device: DeviceState;
  shift: ShiftState | null;
  onShift: (state: ShiftState) => void;
  printer?: Printer | null;
  /** After "Close shift and hand over": who was named to take over next, if anyone. */
  onHandover?: (nextStaffUserId: string | null) => void;
  /** Whether the page is the one shown (Past shifts loads only then). */
  active?: boolean;
}) {
  const [view, setView] = useState<"shift" | "past">("shift");
  const me = device.staffSession?.staffUserId;
  const current = shift?.current ?? null;
  const counter = device.enrollment?.counterLabel ?? "this counter";
  const mine = current && current.staffUserId === me;
  const open = current && current.status !== "opening";
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
        <div className={cx(ui.seg, styles.seg)} role="group" aria-label="Show">
          <button type="button" aria-pressed={view === "shift"} onClick={() => setView("shift")}>
            This shift
          </button>
          <button type="button" aria-pressed={view === "past"} onClick={() => setView("past")}>
            Past shifts
          </button>
        </div>
      </div>
      {view === "past" ? (
        <PastShifts active={active && view === "past"} />
      ) : (
        <div className={styles.body}>
          <div className={styles.left}>
            {open ? (
              <ShiftCard
                shift={current}
                role={roleLabel(device.counterStaff.find((p) => p.staffUserId === current.staffUserId)?.role)}
                actions={current.status === "open" && <XReportButton printer={printer} />}
              />
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
            {open && !mine && current.status === "open" && (
              <div className={ui.note}>
                <Icon name="info" />
                <div>
                  <b>{shiftName(current)} is {current.staffName}&apos;s.</b> They count the drawer and
                  close it before you open yours. If they aren&apos;t here, a manager closes it for
                  them with their own PIN.
                </div>
              </div>
            )}
            {open && (
              <div className={styles.two}>
                <Takings summary={current.summary} />
                <CashLog shift={current} />
              </div>
            )}
            {!current && shift?.lastClosed && <LastClose shift={shift.lastClosed} />}
          </div>
          {open ? (
            <ClosePanel
              key={current.workSessionId}
              device={device}
              shift={current}
              onShift={onShift}
              onHandover={onHandover}
            />
          ) : (
            <OpenShift lastClosed={shift?.lastClosed ?? null} onShift={onShift} />
          )}
        </div>
      )}
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
        <span className={cx(ui.kind, shell.blockIcon, styles.gateIcon)}>
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
