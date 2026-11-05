import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type {
  PaymentMethod,
  RefundAtCounter,
  RefundExecuted,
  RefundReason,
  RefundToday,
  ReturnLine,
  ReturnOutcome,
  ReturnSale,
  SaleFound,
} from "../../shared/ipc-contract";
import { dayMonthYear, shortDay, time } from "./format";
import { Icon } from "./Icon";
import { invoke, moneyInput } from "./invoke";
import { KeyHint } from "./KeyHint";
import { inField, useKeyBinding } from "./keymap";
import r from "./Returns.module.css";
import {
  aroundAmount,
  everything,
  initialChoices,
  lineKey,
  lineRefundMinor,
  METHOD_LABELS,
  methodOptions,
  overLimit,
  paidText,
  REASONS,
  refundLines,
  refundTotalMinor,
  type Choice,
  type Disposition,
} from "./returns-model";
import s from "./Sell.module.css";
import { minor, money } from "./sell-model";
import { Avatar } from "./Shell";
import ui from "./ui.module.css";
import { cx } from "./useAction";

type Tab = "find" | "web" | "today";
type Lookup = "phone" | "date" | "recent" | null;

const POLL_MS = 30_000;

const todayKey = (at = new Date()) => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
};

/** "Exp 05/2027", as the mockup writes a batch's expiry. */
function expiry(date: string | null) {
  if (!date) return null;
  const [year, month] = date.split("-");
  return `Exp ${month}/${year}`;
}

function daysAgo(at: Date, now: Date) {
  const start = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((start(now) - start(at)) / 86_400_000);
  if (days <= 0) return "today";
  return days === 1 ? "yesterday" : `${days} days ago`;
}

const dayMonth = (at: Date) => dayMonthYear(at).replace(/ \d{4}$/, "");

/** Which minutes of the day a sale fell in, for the date search's optional time window. */
const minuteOfDay = (at: Date) => at.getHours() * 60 + at.getMinutes();
const parseTime = (value: string) => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

/**
 * Returns (docs/design/desktop-app, screen=returns): find the sale, choose what comes back and
 * where it goes, and refund it. Online only: it needs the server to find the sale and to move
 * the stock and money (offline refunds are P4).
 */
export function Returns({
  active = true,
  mayApprove = false,
  poll = false,
  onActivity,
  onCount,
}: {
  /** The page is on screen: the search field takes focus, ready for the receipt's barcode. */
  active?: boolean;
  /**
   * The signed-in person's role usually approves refunds (owner or manager), so a refund over
   * the limit is approved as it's prepared. Only the button's wording depends on it: the server
   * decides, and the result says what happened.
   */
  mayApprove?: boolean;
  /** Check "From web" every so often, so a refund approved on the web turns up here. */
  poll?: boolean;
  onActivity?: () => void;
  /** Refunds waiting under "From web", for the rail. */
  onCount?: (count: number) => void;
}) {
  const [tab, setTab] = useState<Tab>("find");
  const [invoiceNo, setInvoiceNo] = useState("");
  const [sale, setSale] = useState<ReturnSale | null>(null);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [reason, setReason] = useState<RefundReason>("wrong_item");
  const [note, setNote] = useState("");
  const [method, setMethod] = useState<PaymentMethod | undefined>(undefined);
  const [outcome, setOutcome] = useState<ReturnOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [lookup, setLookup] = useState<Lookup>(null);
  const [phone, setPhone] = useState("");
  const [day, setDay] = useState(() => todayKey());
  const [fromTime, setFromTime] = useState("");
  const [toTime, setToTime] = useState("");
  const [amount, setAmount] = useState("");
  const [paidBy, setPaidBy] = useState<PaymentMethod | "">("");
  const [mine, setMine] = useState(false);
  const [found, setFound] = useState<SaleFound[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [web, setWeb] = useState<RefundAtCounter[] | null>(null);
  const [webDone, setWebDone] = useState<RefundExecuted | null>(null);
  const [webError, setWebError] = useState<string | null>(null);
  const [webSelected, setWebSelected] = useState<string | null>(null);
  const [today, setToday] = useState<RefundToday[] | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  /** The items list takes focus once a sale opens, so +, −, R, Q and A reach it rather than
   * typing into the search, where letters and "-" belong to invoice numbers. */
  const linesRef = useRef<HTMLDivElement>(null);
  const now = new Date();

  // ---- loading ----
  const loadWeb = useCallback(() => {
    void invoke(() => window.pos.refundsReady()).then((result) =>
      setWeb((list) => (result.ok ? result.value : (list ?? []))),
    );
  }, []);
  const loadToday = useCallback(() => {
    void invoke(() => window.pos.returnsToday()).then((result) =>
      setToday((list) => (result.ok ? result.value : (list ?? []))),
    );
  }, []);
  useEffect(() => {
    loadWeb();
    loadToday();
  }, [loadWeb, loadToday]);
  useEffect(() => {
    if (!poll) return;
    const timer = window.setInterval(loadWeb, POLL_MS);
    return () => window.clearInterval(timer);
  }, [poll, loadWeb]);
  useEffect(() => {
    onCount?.(web?.length ?? 0);
  }, [web, onCount]);
  useEffect(() => {
    if (active && tab === "find") searchRef.current?.focus();
  }, [active, tab]);

  const open = useCallback((next: ReturnSale) => {
    setSale(next);
    setChoices(initialChoices(next));
    setSelected(
      next.lines.find((line) => line.remainingQty > 0)
        ? lineKey(next.lines.find((line) => line.remainingQty > 0)!)
        : null,
    );
    setMethod(undefined);
    setNote("");
    setReason("wrong_item");
    setOutcome(null);
    setError(null);
    window.setTimeout(() => linesRef.current?.focus(), 0);
  }, []);

  async function find(number: string) {
    const term = number.trim();
    if (!term) return;
    setBusy(true);
    setError(null);
    const result = await invoke(() =>
      window.pos.returnFindSale({ invoiceNo: term }),
    );
    setBusy(false);
    if (result.ok) {
      open(result.value);
      setInvoiceNo(result.value.invoiceNo);
      setLookup(null);
      setFound(null);
    } else {
      setSale(null);
      setError(result.error.message);
    }
  }

  async function search(filter: Parameters<typeof window.pos.returnSearchSales>[0], window_?: { from: number | null; to: number | null }) {
    setSearchError(null);
    setFound(null);
    const result = await invoke(() => window.pos.returnSearchSales(filter));
    if (!result.ok) return setSearchError(result.error.message);
    // The history reads whole days; a time window, if given, narrows it here.
    const rows = window_
      ? result.value.filter((row) => {
          const minute = minuteOfDay(new Date(row.soldAt));
          return (
            (window_.from === null || minute >= window_.from) &&
            (window_.to === null || minute <= window_.to)
          );
        })
      : result.value;
    setFound(rows);
  }

  function chooseLookup(next: Lookup) {
    setLookup((current) => (current === next ? null : next));
    setFound(null);
    setSearchError(null);
    if (next === "recent" && lookup !== "recent") {
      const key = todayKey();
      void search({ from: key, to: key });
    }
  }

  function onPhone(event: FormEvent) {
    event.preventDefault();
    if (phone.replace(/\D/g, "").length < 4)
      return setSearchError("Enter at least 4 digits of the phone number.");
    void search({ customerPhone: phone.trim() });
  }

  function onDate(event: FormEvent) {
    event.preventDefault();
    const range = amount ? aroundAmount(amount) : null;
    if (amount && !range) return setSearchError("Enter the amount in rupees.");
    void search(
      {
        from: day,
        to: day,
        ...(range ?? {}),
        ...(paidBy ? { paymentMethod: paidBy } : {}),
        ...(mine ? { soldByMe: true } : {}),
      },
      fromTime || toTime
        ? { from: parseTime(fromTime), to: parseTime(toTime) }
        : undefined,
    );
  }

  // ---- the lines ----
  const lines = sale?.lines ?? [];
  const choice = (line: ReturnLine): Choice =>
    choices[lineKey(line)] ?? { qty: 0, disposition: "restock" };
  const setQty = (line: ReturnLine, qty: number) => {
    const next = Math.max(0, Math.min(line.remainingQty, Math.round(qty) || 0));
    setChoices((current) => ({
      ...current,
      [lineKey(line)]: { ...choice(line), qty: next },
    }));
    setOutcome(null);
  };
  const setDisposition = (line: ReturnLine, disposition: Disposition) => {
    setChoices((current) => ({
      ...current,
      [lineKey(line)]: { ...choice(line), disposition },
    }));
  };
  const selectedLine = lines.find((line) => lineKey(line) === selected) ?? null;

  const totalMinor = sale ? refundTotalMinor(sale, choices) : 0;
  const coming = lines.filter((line) => choice(line).qty > 0);
  const units = coming.reduce((sum, line) => sum + choice(line).qty, 0);
  const restocked = coming.filter((l) => choice(l).disposition === "restock");
  const held = coming.filter((l) => choice(l).disposition === "quarantine");
  const over = sale ? overLimit(sale, totalMinor) : false;
  const methods = useMemo(() => (sale ? methodOptions(sale) : []), [sale]);
  const chosenMethod =
    methods.find((m) => m.method === method) ?? methods[0] ?? null;
  const noteNeeded = reason === "other" && !note.trim();
  const canRefund =
    Boolean(sale) && units > 0 && !busy && !noteNeeded && tab === "find";
  const waitingForSale = sale
    ? (web ?? []).find((w) => w.invoiceNo === sale.invoiceNo)
    : undefined;

  async function refund() {
    if (!sale || !canRefund) return;
    setBusy(true);
    setError(null);
    setOutcome(null);
    const result = await invoke(() =>
      window.pos.submitReturn({
        saleId: sale.saleId,
        lines: refundLines(sale, choices),
        reasonCode: reason,
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(method ? { refundMethod: method } : {}),
      }),
    );
    setBusy(false);
    onActivity?.();
    if (!result.ok) {
      setError(result.error.message);
      loadWeb();
      return;
    }
    setOutcome(result.value);
    loadToday();
    loadWeb();
    // What is left to return has changed (or a request now holds the sale): read it again.
    const again = await invoke(() =>
      window.pos.returnFindSale({ invoiceNo: sale.invoiceNo }),
    );
    if (again.ok) {
      setSale(again.value);
      setChoices(initialChoices(again.value));
    }
  }

  async function executeWeb(id: string) {
    setBusy(true);
    setWebError(null);
    setWebDone(null);
    const result = await invoke(() =>
      window.pos.executeRefund({ refundRequestId: id }),
    );
    setBusy(false);
    onActivity?.();
    if (result.ok) setWebDone(result.value);
    else setWebError(result.error.message);
    loadWeb();
    loadToday();
  }

  function clear() {
    setSale(null);
    setChoices({});
    setSelected(null);
    setInvoiceNo("");
    setOutcome(null);
    setError(null);
    searchRef.current?.focus();
  }

  // ---- keys (keymap.ts) ----
  const webList = web ?? [];
  const webPick =
    webList.find((w) => w.refundRequestId === webSelected) ??
    (webList.length === 1 ? webList[0] : undefined);
  useKeyBinding("F6", () => {
    setTab("find");
    window.setTimeout(() => searchRef.current?.select(), 0);
  });
  useKeyBinding(["F12", "Ctrl+Enter"], () => {
    if (tab === "web") {
      if (!webPick || busy) return false;
      void executeWeb(webPick.refundRequestId);
      return;
    }
    if (!canRefund) return false;
    void refund();
  });
  useKeyBinding("Escape", () => {
    if (lookup) return void setLookup(null);
    if (tab !== "find") return void setTab("find");
    if (sale || invoiceNo) return void clear();
    return false;
  });
  useKeyBinding(
    ["ArrowUp", "ArrowDown"],
    (event) => {
      if (!sale || inField(event.target)) return false;
      const open = lines.filter((line) => line.remainingQty > 0);
      if (!open.length) return false;
      const at = open.findIndex((line) => lineKey(line) === selected);
      const next =
        event.key === "ArrowUp"
          ? Math.max(at - 1, 0)
          : Math.min(at + 1, open.length - 1);
      setSelected(lineKey(open[next]!));
    },
    { repeat: true },
  );
  // + / − change the selected line's quantity; R and Q choose where it goes; A takes everything.
  // Not while typing in a field (the note, the search), where they are letters.
  useKeyBinding(
    ["Plus", "Minus"],
    (event) => {
      if (!selectedLine) return false;
      setQty(selectedLine, choice(selectedLine).qty + (event.key === "+" ? 1 : -1));
    },
    { repeat: true },
  );
  useKeyBinding(["R", "r"], () => {
    if (!selectedLine || choice(selectedLine).qty === 0) return false;
    setDisposition(selectedLine, "restock");
  });
  useKeyBinding(["Q", "q"], () => {
    if (!selectedLine || choice(selectedLine).qty === 0) return false;
    setDisposition(selectedLine, "quarantine");
  });
  useKeyBinding(["A", "a"], () => {
    if (!sale) return false;
    setChoices((current) => everything(sale, current));
  });

  const reasonLabel = (code: string | null) =>
    REASONS.find((x) => x.code === code)?.label ?? code ?? "—";

  // ---- the find panel ----
  const findTab = (
    <>
      <form
        className={cx(s.search, r.search)}
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          void find(invoiceNo);
        }}
      >
        <Icon name="barcode-scan" />
        <input
          ref={searchRef}
          className={ui.mono}
          value={invoiceNo}
          onChange={(e) => setInvoiceNo(e.target.value)}
          placeholder="INV-…"
          aria-label="Receipt barcode or invoice number"
          autoComplete="off"
          spellCheck={false}
        />
        <KeyHint keys="F6" small />
      </form>
      <p className={r.hintL}>
        Scan the barcode on the receipt, or type the invoice number.
      </p>
      <div className={cx(s.chips, r.chips)} role="group" aria-label="No receipt?">
        <button
          type="button"
          className={s.chip}
          aria-pressed={lookup === "phone"}
          onClick={() => chooseLookup("phone")}
        >
          Customer phone
        </button>
        <button
          type="button"
          className={s.chip}
          aria-pressed={lookup === "date"}
          onClick={() => chooseLookup("date")}
        >
          Date and amount
        </button>
        <button
          type="button"
          className={s.chip}
          aria-pressed={lookup === "recent"}
          onClick={() => chooseLookup("recent")}
        >
          Recent at this branch
        </button>
      </div>

      {lookup === "phone" && (
        <form className={r.lookup} onSubmit={onPhone} aria-label="Find by phone">
          <div className={ui.f}>
            <label htmlFor="ret-phone">Customer&apos;s phone</label>
            <input
              id="ret-phone"
              className={ui.in}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="071 482 0937"
              inputMode="tel"
              autoFocus
            />
          </div>
          <button type="submit" className={cx(ui.btn, ui.outline, ui.lg)}>
            <Icon name="search" />
            Find
          </button>
        </form>
      )}
      {lookup === "date" && (
        <form className={r.lookup} onSubmit={onDate} aria-label="Find by date and amount">
          <div className={r.lookupGrid}>
            <div className={ui.f}>
              <label htmlFor="ret-day">Day</label>
              <input
                id="ret-day"
                type="date"
                className={ui.in}
                value={day}
                max={todayKey()}
                onChange={(e) => setDay(e.target.value || todayKey())}
              />
            </div>
            <div className={ui.f}>
              <label htmlFor="ret-amount">
                Total about <span className={ui.muted}>Rs</span>
              </label>
              <input
                id="ret-amount"
                className={ui.in}
                value={amount}
                onChange={(e) => setAmount(moneyInput(e.target.value))}
                inputMode="decimal"
                placeholder="optional"
              />
            </div>
            <div className={ui.f}>
              <label htmlFor="ret-from">From</label>
              <input
                id="ret-from"
                type="time"
                className={ui.in}
                value={fromTime}
                onChange={(e) => setFromTime(e.target.value)}
              />
            </div>
            <div className={ui.f}>
              <label htmlFor="ret-to">To</label>
              <input
                id="ret-to"
                type="time"
                className={ui.in}
                value={toTime}
                onChange={(e) => setToTime(e.target.value)}
              />
            </div>
            <div className={ui.f}>
              <label htmlFor="ret-paid">Paid by</label>
              <div className={ui.select}>
                <select
                  id="ret-paid"
                  className={ui.in}
                  value={paidBy}
                  onChange={(e) => setPaidBy(e.target.value as PaymentMethod | "")}
                >
                  <option value="">Any way</option>
                  {Object.entries(METHOD_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <Icon name="chevron-down" />
              </div>
            </div>
            <label className={r.check}>
              <input
                type="checkbox"
                checked={mine}
                onChange={(e) => setMine(e.target.checked)}
              />
              Sold by me
            </label>
          </div>
          <button type="submit" className={cx(ui.btn, ui.outline, ui.lg)}>
            <Icon name="search" />
            Find
          </button>
        </form>
      )}
      {searchError && (
        <p role="alert" className={cx(ui.badText, r.pad)}>
          {searchError}
        </p>
      )}
      {lookup && found && (
        <ul className={r.found} aria-label="Sales found">
          {found.length === 0 && (
            <li className={r.none}>No sales match. Try a wider search.</li>
          )}
          {found.map((row) => (
            <li key={row.saleId}>
              <button
                type="button"
                className={r.foundRow}
                onClick={() => void find(row.invoiceNo)}
                disabled={busy}
              >
                <span className={r.foundTop}>
                  <span className={ui.mono}>{row.invoiceNo}</span>
                  <b>Rs {money(minor(row.grandTotal))}</b>
                </span>
                <small>
                  {shortDay(new Date(row.soldAt))} · {time(new Date(row.soldAt))}
                  {row.customerName ? ` · ${row.customerName}` : ""}
                  {row.paymentMethods.length
                    ? ` · ${row.paymentMethods.map((m) => METHOD_LABELS[m] ?? m).join(" + ")}`
                    : ""}
                </small>
                <small>{row.summary}</small>
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && !sale && (
        <p role="alert" className={cx(ui.badText, r.pad)}>
          {error}
        </p>
      )}

      {sale && !(lookup && found) && (
        <div className={r.saleFound} aria-label="Sale found">
          <div className={r.foundHead}>
            <Icon name="check-circle" />
            <b>Sale found</b>
            <span className={ui.mono}>{sale.invoiceNo}</span>
          </div>
          <dl>
            <dt>Sold</dt>
            <dd>
              {shortDay(new Date(sale.soldAt))} · {time(new Date(sale.soldAt))}
            </dd>
            <dt>By</dt>
            <dd>{sale.sellerName ?? "—"}</dd>
            <dt>Paid</dt>
            <dd>{paidText(sale)}</dd>
            <dt>Total</dt>
            <dd>
              Rs {money(minor(sale.grandTotal))} · {sale.lines.length} line
              {sale.lines.length === 1 ? "" : "s"}
            </dd>
            <dt>Returns</dt>
            <dd>
              {sale.earlierRefunds.length === 0
                ? "None yet"
                : `${sale.earlierRefunds.length} earlier, on ${sale.earlierRefunds
                    .map((x) => dayMonth(new Date(x.createdAt)))
                    .filter((v, i, all) => all.indexOf(v) === i)
                    .join(", ")}`}
            </dd>
          </dl>
          {sale.customer && (
            <div className={r.who}>
              <Avatar id={sale.customer.phone ?? sale.customer.fullName} name={sale.customer.fullName} />
              <div>
                <b>{sale.customer.fullName}</b>
                <small>{sale.customer.phone ?? "No phone on record"}</small>
              </div>
            </div>
          )}
        </div>
      )}

      {waitingForSale && (
        <button
          type="button"
          className={r.webCard}
          onClick={() => {
            setWebSelected(waitingForSale.refundRequestId);
            setTab("web");
          }}
        >
          <span className={cx(ui.kind, r.webKind)}>
            <Icon name="rotate-ccw" />
          </span>
          <span>
            <b>{waitingForSale.requestNumber} prepared on the web</b>
            <small>
              Rs {money(minor(waitingForSale.amount))}
              {waitingForSale.refundMethod
                ? ` back to ${(METHOD_LABELS[waitingForSale.refundMethod] ?? waitingForSale.refundMethod).toLowerCase()}`
                : " back as paid"}
              {waitingForSale.approvedBy
                ? ` · authorized by ${waitingForSale.approvedBy}`
                : ""}
            </small>
          </span>
          <Icon name="chevron-right" className={r.go} />
        </button>
      )}

      <div className={r.rules}>
        <div>
          <Icon name="info" />
          <span>
            Prescription and controlled items go to quarantine for a pharmacist
            to inspect.
          </span>
        </div>
        <div>
          <Icon name="info" />
          <span>
            {sale?.refundLimit
              ? `Refunds of Rs ${money(minor(sale.refundLimit))} or more need a manager's approval on the web.`
              : "Refunds over the pharmacy's limit need a manager's approval on the web."}
          </span>
        </div>
      </div>
    </>
  );

  const webTab = (
    <div className={r.list}>
      {webDone && (
        <p role="status" className={cx(ui.okText, r.pad)}>
          {webDone.alreadyApplied ? "Already refunded" : "Refunded"}{" "}
          {webDone.requestNumber}:{" "}
          {webDone.refundedTo
            .map((x) => `Rs ${money(x.amountMinor)} ${METHOD_LABELS[x.method]?.toLowerCase() ?? x.method}`)
            .join(", ") || `Rs ${money(webDone.amountMinor)}`}
          . Requested by {webDone.requestedBy ?? "—"}, approved by{" "}
          {webDone.approvedBy ?? "not needed"}, refunded by you.
        </p>
      )}
      {webError && (
        <p role="alert" className={cx(ui.badText, r.pad)}>
          {webError}
        </p>
      )}
      {web !== null && webList.length === 0 && (
        <p className={r.none}>
          No refunds prepared on the web are waiting at this branch.
        </p>
      )}
      {webList.map((w) => {
        const picked = webPick?.refundRequestId === w.refundRequestId;
        return (
          <div
            key={w.refundRequestId}
            className={cx(r.webItem, picked && r.picked)}
            onClick={() => setWebSelected(w.refundRequestId)}
          >
            <span className={cx(ui.kind, r.webKind)}>
              <Icon name="rotate-ccw" />
            </span>
            <div className={r.webBody}>
              <b>
                {w.requestNumber} · Rs {money(minor(w.amount))}
              </b>
              <small>
                {w.invoiceNo ? `Sale ${w.invoiceNo} · ` : ""}
                {w.reason}
              </small>
              <small>
                Prepared by {w.requestedBy ?? "—"} · approved by{" "}
                {w.approvedBy ?? "not needed"}
                {w.refundMethod
                  ? ` · back to ${(METHOD_LABELS[w.refundMethod] ?? w.refundMethod).toLowerCase()}`
                  : " · back as paid"}
              </small>
              <button
                type="button"
                className={cx(ui.btn, ui.primary, ui.sm)}
                onClick={() => void executeWeb(w.refundRequestId)}
                disabled={busy}
              >
                Refund now
                {picked && <KeyHint keys="F12" onPrimary small />}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );

  const todayTab = (
    <div className={r.list}>
      {today !== null && today.length === 0 && (
        <p className={r.none}>No refunds at this branch today.</p>
      )}
      {(today ?? []).map((t) => (
        <div key={t.returnNumber} className={r.todayItem}>
          <span className={r.foundTop}>
            <span className={ui.mono}>{t.returnNumber}</span>
            <b>Rs {money(minor(t.amount))}</b>
          </span>
          <small>
            {time(new Date(t.createdAt))}
            {t.invoiceNo ? ` · ${t.invoiceNo}` : ""} · {reasonLabel(t.reasonCode)}
          </small>
          <small>
            {t.refundedTo.length
              ? t.refundedTo
                  .map((x) => `${METHOD_LABELS[x.method] ?? x.method} ${money(minor(x.amount))}`)
                  .join(" + ")
              : "—"}
            {t.refundedBy ? ` · by ${t.refundedBy}` : ""}
            {t.approvedBy ? ` · approved by ${t.approvedBy}` : ""}
          </small>
        </div>
      ))}
    </div>
  );

  // ---- the ticket ----
  const lineRow = (line: ReturnLine, i: number) => {
    const key = lineKey(line);
    const c = choice(line);
    const sel = key === selected;
    const none = line.remainingQty === 0;
    const lastRefund = sale?.earlierRefunds.at(-1);
    return (
      <div
        key={key}
        className={cx(
          s.ln,
          r.r6,
          sel && !none && s.sel,
          c.qty === 0 && r.off,
        )}
        onClick={() => {
          if (none) return;
          setSelected(key);
          linesRef.current?.focus();
        }}
        aria-label={line.name}
      >
        <span className={s.n}>{i + 1}</span>
        <div>
          <div className={s.nm}>{line.name}</div>
          <div className={s.mt}>
            {line.requiresPrescription && <span className={s.rx}>Rx</span>}
            {line.isControlled && (
              <span className={cx(ui.pill, ui.warn, s.linePill)}>Controlled</span>
            )}
            {none ? (
              <span className={cx(ui.pill, ui.neutral, s.linePill)}>
                Refunded
                {lastRefund ? ` ${dayMonth(new Date(lastRefund.createdAt))}` : ""}
              </span>
            ) : (
              <span>
                {[line.batchNo, expiry(line.expiryDate)]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            )}
          </div>
        </div>
        <div className={r.sold}>
          {line.soldQty}
          {line.unit && <small>{line.unit}</small>}
          {!none && line.remainingQty < line.soldQty && (
            <small>{line.remainingQty} left</small>
          )}
        </div>
        <div className={s.qty}>
          {none ? (
            <span className={r.zero}>None left</span>
          ) : sel || c.qty > 0 ? (
            <span className={cx(s.stepper, !sel && r.calm)}>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setSelected(key);
                  setQty(line, c.qty - 1);
                }}
                disabled={c.qty === 0}
                aria-label="One less"
              >
                <Icon name="minus" />
              </button>
              <input
                type="number"
                min={0}
                max={line.remainingQty}
                value={c.qty}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setQty(line, Number(e.target.value))}
                aria-label={`Quantity of ${line.name} to return`}
              />
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setSelected(key);
                  setQty(line, c.qty + 1);
                }}
                disabled={c.qty >= line.remainingQty}
                aria-label="One more"
              >
                <Icon name="plus" />
              </button>
            </span>
          ) : (
            <span className={r.zero}>0</span>
          )}
        </div>
        <div>
          {c.qty > 0 ? (
            <span className={r.cond} role="group" aria-label={`Where ${line.name} goes`}>
              <button
                type="button"
                aria-pressed={c.disposition === "restock"}
                className={cx(c.disposition === "restock" && r.onOk)}
                onClick={(e) => {
                  e.stopPropagation();
                  setDisposition(line, "restock");
                }}
              >
                {c.disposition === "restock" && <Icon name="check" />}
                Restock
              </button>
              <button
                type="button"
                aria-pressed={c.disposition === "quarantine"}
                className={cx(c.disposition === "quarantine" && r.onQ)}
                onClick={(e) => {
                  e.stopPropagation();
                  setDisposition(line, "quarantine");
                }}
              >
                {c.disposition === "quarantine" && <Icon name="alert-triangle" />}
                Quarantine
              </button>
            </span>
          ) : (
            <span className={r.condNa}>
              {!none && c.disposition === "quarantine"
                ? "Quarantine if returned"
                : "—"}
            </span>
          )}
        </div>
        <span className={cx(s.am, s.r)}>
          {c.qty > 0 ? money(Math.round(lineRefundMinor(line, c.qty))) : "—"}
        </span>
      </div>
    );
  };

  const asPaid = chosenMethod?.method === undefined;
  const methodPill = sale
    ? asPaid
      ? sale.payments.some((p) => p.method === "card")
        ? "Back to the original card"
        : "Back as paid"
      : "Cash from the drawer"
    : null;

  let primaryLabel = `Refund Rs ${money(totalMinor)}`;
  if (over && !mayApprove) primaryLabel = "Send for approval";

  return (
    <div className={r.returns} aria-label="Returns">
      <div className={r.grid}>
        {/* ---------- find ---------- */}
        <section className={cx(ui.panel, r.find)} aria-label="Find a sale">
          <div className={ui.ph}>
            <h2>Returns</h2>
            <span className={ui.grow} />
            <span className={cx(ui.pill, ui.neutral)}>Online only</span>
          </div>
          <div className={cx(ui.seg, r.seg)} role="group" aria-label="Returns">
            <button
              type="button"
              aria-pressed={tab === "find"}
              onClick={() => setTab("find")}
            >
              Find a sale
            </button>
            <button
              type="button"
              aria-pressed={tab === "web"}
              onClick={() => {
                setTab("web");
                loadWeb();
              }}
            >
              From web
              {webList.length > 0 && <i className={r.count}>{webList.length}</i>}
            </button>
            <button
              type="button"
              aria-pressed={tab === "today"}
              onClick={() => {
                setTab("today");
                loadToday();
              }}
            >
              Today
              {(today?.length ?? 0) > 0 && <i className={r.count}>{today!.length}</i>}
            </button>
          </div>
          {tab === "find" ? findTab : tab === "web" ? webTab : todayTab}
        </section>

        {/* ---------- items to return ---------- */}
        <section className={cx(ui.panel, r.ticket)} aria-label="Items to return">
          <div className={ui.ph}>
            <h2>Items to return</h2>
            {sale && <span className={cx(ui.mono, ui.muted)}>{sale.invoiceNo}</span>}
            <span className={ui.grow} />
            {sale && (
              <button
                type="button"
                className={cx(ui.btn, ui.ghost)}
                onClick={() => setChoices((current) => everything(sale, current))}
                disabled={!sale.lines.some((l) => l.remainingQty > 0)}
              >
                <Icon name="rotate-ccw" />
                Return everything
                <KeyHint keys="A" small />
              </button>
            )}
          </div>
          {sale ? (
            <>
              <div className={s.cust}>
                {sale.customer ? (
                  <Avatar
                    id={sale.customer.phone ?? sale.customer.fullName}
                    name={sale.customer.fullName}
                  />
                ) : (
                  <span className={s.walkIn}>
                    <Icon name="user" />
                  </span>
                )}
                <div>
                  <b>{sale.customer?.fullName ?? "Walk-in customer"}</b>
                  <small>
                    Bought {dayMonth(new Date(sale.soldAt))},{" "}
                    {daysAgo(new Date(sale.soldAt), now)} · paid by{" "}
                    {[...new Set(sale.payments.map((p) => p.method))]
                      .map((m) => (METHOD_LABELS[m] ?? m).toLowerCase())
                      .join(" and ") || "—"}
                  </small>
                </div>
                <span className={ui.grow} />
                {methodPill && units > 0 && (
                  <span className={cx(ui.pill, ui.info)}>{methodPill}</span>
                )}
              </div>
              <div className={cx(s.thead, r.r6)}>
                <span>#</span>
                <span>Item</span>
                <span className={s.c}>Sold</span>
                <span className={s.c}>Return</span>
                <span>Condition</span>
                <span className={s.r}>Refund</span>
              </div>
              <div
                ref={linesRef}
                className={cx(s.lines, r.linesFocus)}
                tabIndex={-1}
                aria-label="Lines on the sale"
              >
                {lines.map(lineRow)}
              </div>
              <div className={s.ticketFoot}>
                <span>
                  <b>{coming.length}</b> item{coming.length === 1 ? "" : "s"} ·{" "}
                  <b>{units}</b> unit{units === 1 ? "" : "s"} coming back
                </span>
                <div className={s.keys}>
                  <span>
                    <KeyHint keys="Plus" small />
                    <KeyHint keys="Minus" small /> qty
                  </span>
                  <span>
                    <KeyHint keys="R" small /> restock
                  </span>
                  <span>
                    <KeyHint keys="Q" small /> quarantine
                  </span>
                  <span>
                    <KeyHint keys="A" small /> all
                  </span>
                </div>
              </div>
            </>
          ) : (
            <div className={s.ticketEmpty}>
              <Icon name="rotate-ccw" />
              <b>Find the sale first</b>
              Scan the receipt, type the invoice number, or look the sale up by
              the customer&apos;s phone or the day it was sold.
            </div>
          )}
        </section>

        {/* ---------- refund ---------- */}
        <section className={cx(ui.panel, s.pay, r.refund)} aria-label="Refund">
          <div>
            <div className={s.dueL}>Refund to customer</div>
            <div className={s.dueV}>
              <small>Rs</small>
              {money(totalMinor)}
            </div>
            {coming.length > 0 && sale && (
              <dl className={s.brk}>
                {coming.map((line) => (
                  <FragmentRow
                    key={lineKey(line)}
                    label={`${line.name} ×${choice(line).qty}`}
                    value={money(Math.round(lineRefundMinor(line, choice(line).qty)))}
                  />
                ))}
              </dl>
            )}
          </div>
          <div className={ui.f}>
            <label htmlFor="ret-reason">Reason</label>
            <div className={ui.select}>
              <select
                id="ret-reason"
                className={ui.in}
                value={reason}
                onChange={(e) => setReason(e.target.value as RefundReason)}
                disabled={!sale}
              >
                {REASONS.map((x) => (
                  <option key={x.code} value={x.code}>
                    {x.label}
                  </option>
                ))}
              </select>
              <Icon name="chevron-down" />
            </div>
          </div>
          <div className={ui.f}>
            <label htmlFor="ret-note">
              Note <span className={ui.muted}>{reason === "other" ? "needed for Other" : "optional"}</span>
            </label>
            <input
              id="ret-note"
              className={ui.in}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              disabled={!sale}
            />
          </div>
          {sale && methods.length > 0 && (
            <div>
              <div className={s.fldL}>Refund by</div>
              <div className={cx(s.methods, r.two, methods.length === 1 && r.one)}>
                {methods.map((m) => (
                  <button
                    key={m.method ?? "as-paid"}
                    type="button"
                    className={s.m}
                    aria-pressed={chosenMethod === m}
                    onClick={() => setMethod(m.method)}
                  >
                    <Icon name={m.icon} />
                    <span>
                      {m.label}
                      <small>{m.detail}</small>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {over && sale?.refundLimit && (
            <div className={r.appr} role="note">
              <div className={r.apprH}>
                <Icon name="shield-check" />
                Over the Rs {money(minor(sale.refundLimit))} refund limit
              </div>
              <p>
                {mayApprove
                  ? "You approve it as you refund it, and it's recorded as approved by you."
                  : "A manager approves it on the web. Then it waits under From web, ready to refund here."}
              </p>
            </div>
          )}
          {coming.length > 0 && (
            <div className={r.effect}>
              {restocked.length > 0 && (
                <span className={r.effOk}>
                  <i />
                  {restocked.reduce((n, l) => n + choice(l).qty, 0)} back on the
                  shelf
                </span>
              )}
              {held.length > 0 && (
                <span className={r.effQ}>
                  <i />
                  {held.reduce((n, l) => n + choice(l).qty, 0)} to quarantine,
                  awaiting inspection
                </span>
              )}
            </div>
          )}
          <div className={s.payActions}>
            {outcome?.status === "refunded" && (
              <div role="status" className={cx(ui.note, r.done)}>
                <Icon name="check-circle" />
                <div>
                  <b>
                    {outcome.refund.alreadyApplied ? "Already refunded" : "Refunded"}{" "}
                    Rs {money(outcome.refund.amountMinor)}
                  </b>{" "}
                  {outcome.refund.refundedTo.length > 0 &&
                    `· ${outcome.refund.refundedTo
                      .map((x) => `${METHOD_LABELS[x.method] ?? x.method} ${money(x.amountMinor)}`)
                      .join(" + ")}`}
                  {outcome.refund.refundedTo.some((x) => x.method === "cash") &&
                    ". Give the cash from the drawer."}
                  {outcome.refund.approvedBy
                    ? ` Approved by ${outcome.refund.approvedBy}.`
                    : ""}
                </div>
              </div>
            )}
            {outcome?.status === "awaiting_approval" && (
              <div role="status" className={cx(ui.note, ui.noteWarn)}>
                <Icon name="shield-check" />
                <div>
                  <b>Sent for approval as {outcome.requestNumber}</b> · Rs{" "}
                  {money(minor(outcome.amount))}. Nothing has been refunded yet.
                  When a manager approves it on the web, it appears under From
                  web, ready to refund here.
                </div>
              </div>
            )}
            {error && sale && (
              <p role="alert" className={ui.badText}>
                {error}
              </p>
            )}
            {noteNeeded && units > 0 && (
              <p className={ui.muted}>Add a note to say what &ldquo;Other&rdquo; was.</p>
            )}
            <button
              type="button"
              className={cx(ui.btn, ui.primary, s.xl)}
              onClick={() => void refund()}
              disabled={!canRefund}
            >
              <Icon name="rotate-ccw" />
              {busy ? "Refunding…" : primaryLabel}
              <KeyHint keys="F12" onPrimary small />
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

function FragmentRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}
