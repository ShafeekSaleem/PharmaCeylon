import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  CounterWorkItem,
  CounterWorkKind,
  RefundAtCounter,
  RefundExecuted,
} from "../../shared/ipc-contract";
import styles from "./CounterWork.module.css";
import { dayMonthYear, time } from "./format";
import { Icon, type IconName } from "./Icon";
import { invoke } from "./invoke";
import { KeyHint } from "./KeyHint";
import { useKeyBinding } from "./keymap";
import { minor, money } from "./sell-model";
import ui from "./ui.module.css";
import { cx } from "./useAction";

const POLL_MS = 30_000;

export type WorkTab = "all" | "receive" | "transfers" | "refunds" | "stock";
type Pending = {
  commandId: string;
  operation: string;
  createdAt: string;
  staffName: string | null;
};

/** How each kind of work reads on the page: its tab, name, icon and colour, and what the counter does. */
const KINDS: Record<
  CounterWorkKind,
  {
    tab: Exclude<WorkTab, "all">;
    title: string;
    icon: IconName;
    tone: string;
    /** The pill on its card while it matches its approval. */
    ready: { label: string; tone: string };
    /** The third step: what the person at the counter is doing. */
    doing: string;
  }
> = {
  prepared_receipt: {
    tab: "receive",
    title: "Receive goods",
    icon: "package-check",
    tone: styles.teal!,
    ready: { label: "Ready to receive", tone: ui.ok! },
    doing: "Receiving",
  },
  held_delivery: {
    tab: "receive",
    title: "Held delivery",
    icon: "package-check",
    tone: styles.teal!,
    ready: { label: "Accepted · book it in", tone: ui.ok! },
    doing: "Receiving",
  },
  transfer_receive: {
    tab: "transfers",
    title: "Transfer in",
    icon: "arrow-left-right",
    tone: styles.cyan!,
    ready: { label: "On the way", tone: ui.info! },
    doing: "Receiving",
  },
  transfer_ship: {
    tab: "transfers",
    title: "Transfer out",
    icon: "upload",
    tone: styles.indigo!,
    ready: { label: "Ready to pick", tone: ui.neutral! },
    doing: "Dispatching",
  },
  refund: {
    tab: "refunds",
    title: "Refund",
    icon: "rotate-ccw",
    tone: styles.rose!,
    ready: { label: "Inspect returned goods", tone: ui.warn! },
    doing: "Refunding",
  },
  held_adjustment: {
    tab: "stock",
    title: "Write-off",
    icon: "alert-triangle",
    tone: styles.amber!,
    ready: { label: "Ready to write off", tone: ui.warn! },
    doing: "Writing off",
  },
  stocktake: {
    tab: "stock",
    title: "Stocktake",
    icon: "clipboard-list",
    tone: styles.emerald!,
    ready: { label: "Approved · post the count", tone: ui.info! },
    doing: "Posting",
  },
  supplier_return: {
    tab: "stock",
    title: "Supplier return",
    icon: "package",
    tone: styles.violet!,
    ready: { label: "Ready to send back", tone: ui.neutral! },
    doing: "Sending back",
  },
  import_stock: {
    tab: "stock",
    title: "Opening stock",
    icon: "file-text",
    tone: styles.blue!,
    ready: { label: "Ready to post", tone: ui.neutral! },
    doing: "Posting",
  },
};

const TABS: { tab: WorkTab; label: string }[] = [
  { tab: "all", label: "All" },
  { tab: "receive", label: "Receive" },
  { tab: "transfers", label: "Transfers" },
  { tab: "refunds", label: "Refunds" },
  { tab: "stock", label: "Stock" },
];

/** Signed operations in words, for actions sent from here that are waiting to be confirmed. */
const OPERATIONS: Record<string, string> = {
  "POST /api/v1/sales/refund-requests/:id/execute": "Refund",
  "POST /api/v1/purchasing/prepared-receipts/:id/post": "Receive goods",
  "POST /api/v1/purchasing/held-deliveries/:id/post": "Held delivery",
  "POST /api/v1/transfers/:id/ship": "Transfer out",
  "POST /api/v1/transfers/:id/receive": "Transfer in",
  "POST /api/v1/stocktakes/:id/post": "Stocktake",
  "POST /api/v1/inventory/held-adjustments/:id/post": "Write-off",
  "POST /api/v1/inventory/adjustments": "Stock adjustment",
  "POST /api/v1/returns/:id/complete": "Supplier return",
  "POST /api/v1/products/import/:importId/stock/post": "Opening stock",
  "POST /api/v1/products/import/:importId/undo-stock": "Undo opening stock",
  "POST /api/v1/prescriptions": "Prescription",
};
export const operationName = (operation: string) =>
  OPERATIONS[operation] ?? "Counter action";

const rs = (amount: string) => `Rs ${money(minor(amount))}`;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** "Dilini Fernando" → "Dilini F.", as the mockup writes people on a card. */
export function shortName(name: string | null) {
  if (!name) return "—";
  const words = name.trim().split(/\s+/);
  return words.length > 1
    ? `${words[0]} ${words[words.length - 1]!.charAt(0)}.`
    : words[0]!;
}

function sameDay(a: Date, b: Date) {
  return dayMonthYear(a) === dayMonthYear(b);
}

/** "13:50" today, "Yesterday", else "29 Oct 2026". */
export function when(iso: string, now = new Date()) {
  const date = new Date(iso);
  if (sameDay(date, now)) return time(date);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return "Yesterday";
  return dayMonthYear(date);
}

/** "29 Oct 2026, 10:40" for a step in the trail. */
const at = (iso: string | null) =>
  iso ? `${dayMonthYear(new Date(iso))}, ${time(new Date(iso))}` : null;

function describe(item: CounterWorkItem, refund?: RefundAtCounter) {
  const lines = plural(item.lineCount, "line");
  const amount = item.amount ? rs(item.amount) : null;
  switch (item.kind) {
    case "prepared_receipt":
    case "held_delivery":
    case "supplier_return":
      return [item.subject, lines, amount].filter(Boolean).join(" · ");
    case "transfer_receive":
      return `From ${item.subject ?? "another branch"} · ${lines}`;
    case "transfer_ship":
      return `To ${item.subject ?? "another branch"} · ${lines} · pick and dispatch`;
    case "refund":
      return [
        item.subject ? `Sale ${item.subject}` : null,
        amount &&
          (refund?.refundMethod
            ? `${amount} back to ${refund.refundMethod}`
            : amount),
      ]
        .filter(Boolean)
        .join(" · ");
    case "held_adjustment":
      return [item.subject, `batch ${item.reference}`, amount && `${amount} at cost`]
        .filter(Boolean)
        .join(" · ");
    case "stocktake":
      return [item.subject, lines].filter(Boolean).join(" · ");
    case "import_stock":
      return `${plural(item.lineCount, "batch")} of opening stock`.replace(
        "batchs",
        "batches",
      );
  }
}

function byLine(item: CounterWorkItem) {
  if (item.kind === "transfer_receive")
    return item.dispatched
      ? `Dispatched by ${shortName(item.dispatched.name)}`
      : null;
  if (item.kind === "import_stock")
    return `Staged by ${shortName(item.requested?.name ?? null)}`;
  if (!item.approved) return "No approval needed";
  return `${item.kind === "refund" ? "Authorized" : "Approved"} by ${shortName(item.approved.name)}`;
}

function statePill(item: CounterWorkItem) {
  if (item.approval.state === "changed")
    return { label: "Changed since approval", tone: ui.warn! };
  if (item.approval.state === "revoked")
    return { label: "Approval withdrawn", tone: ui.bad! };
  return KINDS[item.kind].ready;
}

const blocked = (item: CounterWorkItem) =>
  item.approval.state === "changed" || item.approval.state === "revoked";

function QueueCard({
  item,
  refund,
  selected,
  onSelect,
}: {
  item: CounterWorkItem;
  refund?: RefundAtCounter;
  selected: boolean;
  onSelect: () => void;
}) {
  const kind = KINDS[item.kind];
  const pill = statePill(item);
  const by = byLine(item);
  return (
    <button
      type="button"
      className={styles.card}
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
    >
      <span className={cx(ui.kind, styles.kind, kind.tone)}>
        <Icon name={kind.icon} />
      </span>
      <span className={styles.cardMain}>
        <span className={styles.cardTop}>
          <b>{kind.title}</b>
          <span className={cx(ui.mono, styles.ref)}>{item.reference}</span>
          <span className={styles.when}>{when(item.readyAt)}</span>
        </span>
        <span className={styles.desc}>
          {describe(item, refund)}
        </span>
        <span className={styles.cardFoot}>
          <span className={cx(ui.pill, pill.tone)}>{pill.label}</span>
          {by && <span className={styles.by}>{by}</span>}
        </span>
      </span>
    </button>
  );
}

/** The trail every kind shares: who asked, who approved which version, and you. */
export function WorkHeader({
  item,
  you,
  counterLabel,
}: {
  item: CounterWorkItem;
  you: string;
  counterLabel: string | null;
}) {
  const kind = KINDS[item.kind];
  const { approval } = item;
  const middle =
    item.kind === "transfer_receive"
      ? {
          label: "Dispatched",
          person: item.dispatched,
          detail: "from the other branch",
        }
      : {
          label:
            approval.state === "not_needed"
              ? "Approval"
              : `Approved${approval.approvedVersion ? ` · v${approval.approvedVersion}` : ""}`,
          person: item.approved,
          detail: "on the web",
        };
  const middleTone =
    approval.state === "revoked"
      ? styles.badStep
      : approval.state === "changed"
        ? styles.warnStep
        : styles.done;
  return (
    <>
      <ol className={styles.trail} aria-label="Who asked, who approved and who is doing it">
        <li className={cx(styles.step, styles.done)}>
          <span className={styles.dot}>
            <Icon name="check" />
          </span>
          <div>
            <div className={styles.stepLabel}>
              {item.kind === "import_stock" ? "Staged" : "Requested"}
            </div>
            <b>{item.requested?.name ?? "—"}</b>
            <small>{at(item.requested?.at ?? null) ?? " "}</small>
          </div>
        </li>
        <li className={cx(styles.step, middleTone)}>
          <span className={styles.dot}>
            <Icon
              name={
                approval.state === "revoked"
                  ? "x"
                  : approval.state === "changed"
                    ? "alert-triangle"
                    : "check"
              }
            />
          </span>
          <div>
            <div className={styles.stepLabel}>{middle.label}</div>
            <b>
              {middle.person?.name ??
                (approval.state === "not_needed" ? "Not needed" : "—")}
            </b>
            <small>
              {middle.person?.at
                ? `${middle.detail} · ${at(middle.person.at)}`
                : " "}
            </small>
          </div>
        </li>
        <li className={cx(styles.step, styles.now)}>
          <span className={styles.dot}>
            <Icon name={kind.icon} />
          </span>
          <div>
            <div className={styles.stepLabel}>{kind.doing}</div>
            <b>You · {you}</b>
            <small>
              {counterLabel ? `${counterLabel} · ` : ""}at the counter · now
            </small>
          </div>
        </li>
      </ol>
      <ApprovalNote item={item} />
    </>
  );
}

function ApprovalNote({ item }: { item: CounterWorkItem }) {
  const { approval } = item;
  if (approval.state === "matches")
    return (
      <p className={styles.trailNote} role="status">
        <Icon name="shield-check" />
        Matches the approved version — nothing has changed since approval.
      </p>
    );
  if (approval.state === "not_needed")
    return (
      <p className={cx(styles.trailNote, styles.waived)} role="status">
        <Icon name="info" />
        {item.kind === "import_stock"
          ? "Opening stock from an import needs no approval."
          : item.kind === "transfer_receive"
            ? "Sent without an approval step: branch transfers don't need one here."
            : "No approval was needed for this."}
      </p>
    );
  if (approval.state === "revoked")
    return (
      <p className={cx(styles.trailNote, styles.revoked)} role="alert">
        <Icon name="alert-triangle" />
        The approval was withdrawn on the web. It can&apos;t be done here until
        someone approves it again.
      </p>
    );
  return (
    <div className={cx(styles.trailNote, styles.changed)} role="alert">
      <Icon name="alert-triangle" />
      <div>
        Changed since approval
        {approval.approvedVersion !== null && approval.currentVersion !== null
          ? ` (approved v${approval.approvedVersion}, now v${approval.currentVersion})`
          : ""}
        . Ask for it to be approved again on the web before doing it here.
        {approval.changes.length > 0 && (
          <ul aria-label="What changed">
            {approval.changes.map((change) => (
              <li key={change}>{change}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Detail({
  item,
  refund,
  you,
  counterLabel,
  busy,
  canRefund,
  onRefund,
  error,
}: {
  item: CounterWorkItem;
  refund?: RefundAtCounter;
  you: string;
  counterLabel: string | null;
  busy: boolean;
  /** Only when nothing is waiting to be confirmed: never do a second thing while one is unknown. */
  canRefund: boolean;
  onRefund: (id: string) => void;
  error: string | null;
}) {
  const kind = KINDS[item.kind];
  const ready = !blocked(item);
  const title = [item.reference, item.subject].filter(Boolean).join(" · ");
  return (
    <section
      className={cx(ui.panel, styles.detail)}
      aria-label={`${kind.title} ${item.reference}`}
    >
      <div className={styles.dh}>
        <span className={cx(ui.kind, styles.kind, kind.tone)}>
          <Icon name={kind.icon} />
        </span>
        <div className={styles.dhMain}>
          <div className={ui.eyebrow}>{kind.title}</div>
          <h2>{title}</h2>
          <div className={styles.meta}>
            {item.kind === "refund" && item.subject && (
              <span>
                <Icon name="receipt" />
                Sale {item.subject}
              </span>
            )}
            {item.lineCount > 0 && (
              <span>
                <Icon name="package" />
                {plural(item.lineCount, item.kind === "import_stock" ? "batch" : "line").replace("batchs", "batches")}
              </span>
            )}
            {item.amount && (
              <span>
                <Icon name="dollar-sign" />
                {rs(item.amount)}
              </span>
            )}
          </div>
        </div>
        <div className={styles.dhRight}>
          <span className={cx(ui.pill, ready ? ui.brand : statePill(item).tone)}>
            <Icon name={ready ? "check" : "alert-triangle"} />
            {ready
              ? item.approval.state === "not_needed"
                ? "Waiting at the counter"
                : "Approved — waiting at the counter"
              : statePill(item).label}
          </span>
        </div>
      </div>

      <WorkHeader item={item} you={you} counterLabel={counterLabel} />

      {item.kind === "refund" ? (
        <RefundPane item={item} refund={refund} />
      ) : (
        <div className={styles.content}>
          <div className={cx(ui.note, styles.waiting)} role="note">
            <Icon name="clock" />
            <div>
              <b>Done at the counter once its screen is ready</b>
              {kind.title} {item.reference} is approved and waiting here. The
              screen for {kind.doing.toLowerCase()} it at the counter comes
              next; until then nothing moves from this page.
            </div>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className={cx(ui.badText, styles.result)}>
          {error}
        </p>
      )}

      <div className={ui.dfoot}>
        <span className={styles.footText}>
          {item.kind === "refund" ? (
            <>
              <b>{item.amount ? rs(item.amount) : "—"}</b>
              {refund?.refundMethod
                ? `back to ${refund.refundMethod}`
                : "back the way the sale was paid"}
            </>
          ) : (
            <>
              <b>Nothing to do here yet</b>
              Stock only moves when its screen posts it.
            </>
          )}
        </span>
        <span className={ui.grow} />
        {item.kind === "refund" && (
          <button
            type="button"
            className={cx(ui.btn, ui.primary, ui.lg)}
            disabled={busy || !ready || !refund || !canRefund}
            onClick={() => onRefund(item.id)}
          >
            <Icon name="rotate-ccw" />
            Refund now
            <KeyHint keys="F12" onPrimary spaced />
          </button>
        )}
      </div>
    </section>
  );
}

function RefundPane({
  item,
  refund,
}: {
  item: CounterWorkItem;
  refund?: RefundAtCounter;
}) {
  return (
    <div className={styles.content}>
      <div className={cx(ui.kvs, styles.facts)}>
        <div className={ui.kv}>
          Sale<b>{item.subject ?? "—"}</b>
        </div>
        <div className={ui.kv}>
          Amount<b>{item.amount ? rs(item.amount) : "—"}</b>
        </div>
        <div className={ui.kv}>
          Back to<b>{refund?.refundMethod ?? "How the sale was paid"}</b>
        </div>
        <div className={ui.kv}>
          Reason<b>{refund?.reason ?? "—"}</b>
        </div>
      </div>
      <div className={cx(ui.note, styles.waiting)} role="note">
        <Icon name="info" />
        <div>
          Check the returned goods against the sale before refunding. Cash
          comes out of this drawer.
        </div>
      </div>
    </div>
  );
}

function PendingCard({
  pending,
  only,
  onConfirm,
  error,
}: {
  pending: Pending[];
  only: boolean;
  onConfirm: (commandId: string) => void;
  error: string | null;
}) {
  return (
    <div className={cx(styles.card, styles.unconfirmed)} role="alert">
      <h3>
        <Icon name="alert-triangle" />
        Sent but not confirmed
      </h3>
      <p>
        An action was sent but not confirmed. Confirm it before doing it again.
      </p>
      {pending.map((p) => (
        <div key={p.commandId} className={styles.pendingRow}>
          <span>
            {operationName(p.operation)}
            <small>
              Sent at {time(new Date(p.createdAt))}
              {p.staffName ? ` by ${p.staffName}` : ""}
            </small>
          </span>
          <button
            type="button"
            className={cx(ui.btn, ui.outline, ui.sm)}
            onClick={() => onConfirm(p.commandId)}
          >
            Confirm action from {time(new Date(p.createdAt))}
            {only && <KeyHint keys="Ctrl+Enter" spaced />}
          </button>
        </div>
      ))}
      {error && <p className={ui.badText}>{error}</p>}
    </div>
  );
}

/**
 * Counter work: what was approved on the web and waits for this branch's counter, in tabs, with
 * one item open beside the list. Every kind shares the same header (who asked, who approved which
 * version, you, and whether it still matches). Refunds execute here; the other kinds show their
 * header and wait for their own screens (P6). Actions sent from here without an answer stay at
 * the top until confirmed.
 */
export function CounterWork({
  onActivity,
  onCount,
  reloadKey = 0,
  poll = false,
  you = "",
  counterLabel = null,
}: {
  onActivity?: () => void;
  /** How many items are waiting, for the rail's badge. */
  onCount?: (count: number) => void;
  reloadKey?: number;
  /** Check again every so often, so work approved on the web turns up without a new sign-in. */
  poll?: boolean;
  /** The signed-in person, who executes whatever is opened here. */
  you?: string;
  counterLabel?: string | null;
} = {}) {
  const [items, setItems] = useState<CounterWorkItem[] | null>(null);
  const [refunds, setRefunds] = useState<RefundAtCounter[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [tab, setTab] = useState<WorkTab>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [done, setDone] = useState<RefundExecuted | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    (quiet = false) => {
      // A failed check keeps the list it had: a network blip shouldn't empty the page or the badge.
      void invoke(() => window.pos.counterWork()).then((result) =>
        setItems((list) => (result.ok ? result.value : (list ?? []))),
      );
      void invoke(() => window.pos.refundsReady()).then((result) => {
        if (result.ok) setRefunds(result.value);
      });
      void window.pos
        .pendingCommands()
        .then((list) => {
          setPending(list);
          if (!quiet) onActivity?.();
        })
        .catch(() => undefined);
    },
    [onActivity],
  );
  // Reloaded when a signed command is sent elsewhere (a prescription), so one left unconfirmed
  // shows here with its confirm button.
  useEffect(() => load(), [load, reloadKey]);
  useEffect(() => {
    if (!poll) return;
    const timer = window.setInterval(() => load(true), POLL_MS);
    return () => window.clearInterval(timer);
  }, [poll, load]);
  useEffect(() => {
    onCount?.((items?.length ?? 0) + pending.length);
  }, [items, pending, onCount]);

  const counts = useMemo(() => {
    const all = items ?? [];
    const by = (t: WorkTab) =>
      t === "all" ? all.length : all.filter((i) => KINDS[i.kind].tab === t).length;
    return Object.fromEntries(TABS.map(({ tab: t }) => [t, by(t)])) as Record<
      WorkTab,
      number
    >;
  }, [items]);
  const shown = useMemo(
    () =>
      (items ?? []).filter((i) => tab === "all" || KINDS[i.kind].tab === tab),
    [items, tab],
  );
  // The open item stays open while it is listed; otherwise the first one in the tab.
  const selected =
    shown.find((i) => i.id === selectedId) ?? shown[0] ?? null;
  const refundFor = (item: CounterWorkItem) =>
    item.kind === "refund"
      ? refunds.find((r) => r.refundRequestId === item.id)
      : undefined;

  async function execute(id: string) {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const result = await invoke(() =>
        window.pos.executeRefund({ refundRequestId: id }),
      );
      if (result.ok) setDone(result.value);
      else setError(result.error.message);
    } finally {
      setBusy(false);
      load();
    }
  }

  async function confirm(commandId: string) {
    setConfirmError(null);
    const result = await invoke(() => window.pos.retryCommand({ commandId }));
    if (!result.ok) setConfirmError(result.error.message);
    load();
  }

  function select(id: string) {
    setSelectedId(id);
    setError(null);
  }

  // Ctrl+Enter confirms an unconfirmed action first, so nothing is done twice. Otherwise F12 or
  // Ctrl+Enter refunds the open refund.
  const onlyPending = pending.length === 1 ? pending[0] : null;
  const openRefund =
    !pending.length &&
    !busy &&
    selected?.kind === "refund" &&
    !blocked(selected) &&
    refundFor(selected)
      ? selected
      : null;
  useKeyBinding("Ctrl+Enter", () => void confirm(onlyPending!.commandId), {
    enabled: Boolean(onlyPending),
  });
  useKeyBinding(["F12", "Ctrl+Enter"], () => void execute(openRefund!.id), {
    enabled: Boolean(openRefund),
  });
  // Up and down move through the list.
  const move = (step: number) => {
    if (!shown.length) return false;
    const index = selected ? shown.indexOf(selected) : -1;
    const next = shown[Math.min(shown.length - 1, Math.max(0, index + step))];
    if (next) select(next.id);
  };
  useKeyBinding("ArrowDown", () => move(1), { enabled: shown.length > 1 });
  useKeyBinding("ArrowUp", () => move(-1), { enabled: shown.length > 1 });

  if (items === null) return null;
  return (
    <div className={styles.page}>
      <div className={cx(ui.pageH, styles.head)}>
        <div>
          <h1>Counter work</h1>
          <p>
            Approved on the web and waiting for this branch. Stock and cash
            only move when you finish it here.
          </p>
        </div>
        <div className={cx(ui.seg, styles.tabs)} role="group" aria-label="Kind of work">
          {TABS.map(({ tab: t, label }) => (
            <button
              key={t}
              type="button"
              aria-pressed={tab === t}
              onClick={() => setTab(t)}
            >
              {label} <i>{counts[t]}</i>
            </button>
          ))}
        </div>
      </div>
      <div className={styles.body}>
        <div className={styles.queue} aria-label="Waiting at the counter">
          {pending.length > 0 && (
            <PendingCard
              pending={pending}
              only={Boolean(onlyPending)}
              onConfirm={(id) => void confirm(id)}
              error={confirmError}
            />
          )}
          {done && (
            <p role="status" className={styles.doneHere}>
              <Icon name="check-circle" />
              <span>
                {done.alreadyApplied ? "Already refunded" : "Refunded"}{" "}
                {done.requestNumber}:{" "}
                {done.refundedTo
                  .map((r) => `Rs ${money(r.amountMinor)} ${r.method}`)
                  .join(", ") || `Rs ${money(done.amountMinor)}`}
                . Requested by {done.requestedBy ?? "—"}, approved by{" "}
                {done.approvedBy ?? "not needed"}, executed by you.
              </span>
            </p>
          )}
          {shown.map((item) => (
            <QueueCard
              key={item.id}
              item={item}
              refund={refundFor(item)}
              selected={item === selected}
              onSelect={() => select(item.id)}
            />
          ))}
          {!shown.length && (
            <div className={styles.queueEmpty}>
              <Icon name="inbox" />
              {tab === "all"
                ? "Nothing is waiting at this counter."
                : `No ${TABS.find((t) => t.tab === tab)!.label.toLowerCase()} work is waiting.`}
            </div>
          )}
        </div>
        {selected ? (
          <Detail
            key={selected.id}
            item={selected}
            refund={refundFor(selected)}
            you={you}
            counterLabel={counterLabel}
            busy={busy}
            canRefund={!pending.length}
            onRefund={(id) => void execute(id)}
            error={error}
          />
        ) : (
          <section className={ui.panel} aria-label="Nothing open">
            <div className={styles.noSelection}>
              <Icon name="inbox" />
              When something is approved on the web for this branch, it
              opens here.
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
