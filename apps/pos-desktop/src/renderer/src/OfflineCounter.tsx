import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type { z } from "zod";
import type {
  DeviceState,
  JournalSync,
  OfflineModeState,
  OfflineReceiptView,
  OfflineStaff,
  Printer,
  ShiftState,
  offlineQuoteSchema,
} from "../../shared/ipc-contract";
import { DrawerTable } from "./CashShift";
import { counted, drawerCount, type DrawerEntry } from "./cash-count";
import { time, useNow } from "./format";
import full from "./Fullscreen.module.css";
import { Icon, type IconName } from "./Icon";
import { moneyInput } from "./invoke";
import { KeyHint } from "./KeyHint";
import { clickSubmit, inField, useKeyBinding } from "./keymap";
import {
  blockedText,
  expiryText,
  findOfflineLines,
  hoursBlock,
  offlineLineName,
  remainingText,
  sellingBanner,
  type OfflineStockLine,
} from "./offline-sell-model";
import styles from "./OfflineCounter.module.css";
import cash from "./CashShift.module.css";
import { minor, money, plainMoney, quickTenders } from "./sell-model";
import s from "./Sell.module.css";
import shell from "./Shell.module.css";
import { Avatar, RailItem, type Page } from "./Shell";
import { PIN_OK, PinPad } from "./SignIn";
import signIn from "./SignIn.module.css";
import { tillDisplayName } from "./this-counter-display";
import ui from "./ui.module.css";
import { cx, ErrorLine, useAction } from "./useAction";

/**
 * P4 #50: the branch's nominated counter while the server can't be reached. People sign in with
 * their PIN, checked on this computer; the shift opens as a journal entry; sales are priced from
 * the signed stock snapshot and saved here, with a final receipt number, to upload later.
 */

const STAFF_MS = 3_000;
type Quote = z.infer<typeof offlineQuoteSchema>;

export function OfflineCounter({
  device,
  mode,
  journal,
  shift,
  onShift,
  printer,
}: {
  device: DeviceState;
  mode: OfflineModeState;
  journal: JournalSync | null;
  shift: ShiftState | null;
  onShift: () => void;
  printer: Printer | null | undefined;
}) {
  const [staff, setStaff] = useState<OfflineStaff | null>(null);
  const [page, setPage] = useState<Page>("sell");
  const loadStaff = useCallback(() => {
    window.pos
      .offlineStaff()
      .then(setStaff)
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    loadStaff();
    const timer = window.setInterval(loadStaff, STAFF_MS);
    return () => window.clearInterval(timer);
  }, [loadStaff]);

  const me = staff?.signedIn ?? null;
  useEffect(() => setPage("sell"), [me?.workSessionId]);
  if (!staff) return null;
  if (!me)
    return <OfflineSignIn device={device} staff={staff} onStaff={setStaff} />;

  const current = shift?.current ?? null;
  const mine =
    current?.status === "open" && current.staffUserId === me.staffUserId;
  const enrollment = device.enrollment;
  return (
    <div className={shell.work}>
      <div className={shell.frame}>
        <nav className={shell.rail} aria-label="Pages">
          {(
            [
              ["sell", "shopping-cart", "Sell"],
              ["returns", "rotate-ccw", "Returns"],
              ["cash", "wallet", "Cash & shift"],
              ["stock", "clipboard-list", "Stock"],
              ["counter", "monitor", "This counter"],
            ] as [Page, IconName, string][]
          ).map(([id, icon, label]) => (
            <RailItem
              key={id}
              icon={icon}
              label={label}
              active={page === id}
              onClick={() => setPage(id)}
            />
          ))}
        </nav>
        <main className={shell.content}>
          {page === "sell" ? (
            mine ? (
              <OfflineSell
                mode={mode}
                staff={staff}
                printer={printer}
                onSold={onShift}
              />
            ) : current && current.status !== "closed" ? (
              <div className={shell.block} role="alert">
                <div className={cx(ui.panel, shell.blockCard)}>
                  <span className={cx(ui.kind, shell.blockIcon)}>
                    <Icon name="wallet" />
                  </span>
                  <h2>{current.staffName}&apos;s shift is open on this till</h2>
                  <p>
                    {current.staffName.split(" ")[0]} continues it. To sell,
                    they sign in here and keep selling, or count the drawer and
                    close it first.
                  </p>
                </div>
              </div>
            ) : (
              <OfflineOpenShift onOpened={onShift} />
            )
          ) : (
            <OfflineBlocked page={page} />
          )}
        </main>
      </div>
      <footer className={shell.statusbar}>
        <span className={shell.sb}>
          <Icon name="user" />
          <b>{me.staffName}</b>
        </span>
        {mine && current && (
          <span className={shell.sb}>
            <Icon name="clock" />
            Shift open {time(new Date(current.openedAt))}
          </span>
        )}
        {enrollment && (
          <span className={shell.sb}>
            {enrollment.branchName} ·{" "}
            {tillDisplayName(enrollment.counterLabel, enrollment.tillId)}
          </span>
        )}
        <span className={ui.grow} />
        {journal && journal.waiting > 0 && (
          <span className={shell.sb}>{journal.waiting} to send</span>
        )}
      </footer>
    </div>
  );
}

/** Everyone the grant prepared for this counter, and a PIN pad checked on this computer. */
function OfflineSignIn({
  device,
  staff,
  onStaff,
}: {
  device: DeviceState;
  staff: OfflineStaff;
  onStaff: (staff: OfflineStaff) => void;
}) {
  const now = useNow();
  const [chosen, setChosen] = useState<string | null>(null);
  const [pin, setPin] = useState("");
  const { busy, error, run, clear } = useAction();
  const ready = staff.people.filter((p) => p.lockRemainingMs === 0);
  const selected =
    ready.find((p) => p.staffUserId === chosen) ?? ready[0] ?? null;
  const enrollment = device.enrollment;

  function submit() {
    if (!selected || !PIN_OK.test(pin)) return;
    const entered = pin;
    setPin("");
    void run(
      () =>
        window.pos.offlineSignIn({
          staffUserId: selected.staffUserId,
          pin: entered,
        }),
      onStaff,
    );
  }

  return (
    <section className={full.screen} aria-label="Sign in offline">
      <div className={full.wrap}>
        <div className={full.head}>
          <div className={full.time}>{time(now)}</div>
          <div className={full.date}>
            {enrollment &&
              `${enrollment.branchName} · ${tillDisplayName(enrollment.counterLabel, enrollment.tillId)}`}
          </div>
        </div>
        <div className={cx(full.card, signIn.card)}>
          <div className={signIn.who}>
            <h2>Who&apos;s at the counter?</h2>
            <p>
              The server can&apos;t be reached, so this counter checks your PIN
              itself. Only people prepared for offline selling here are listed.
            </p>
            <div className={signIn.staff}>
              {staff.people.map((person) => {
                const locked = person.lockRemainingMs > 0;
                return (
                  <button
                    key={person.staffUserId}
                    type="button"
                    className={cx(
                      signIn.st,
                      person.staffUserId === selected?.staffUserId &&
                        signIn.sel,
                      locked && signIn.off,
                    )}
                    aria-pressed={person.staffUserId === selected?.staffUserId}
                    onClick={() => {
                      setChosen(person.staffUserId);
                      setPin("");
                      clear();
                    }}
                    disabled={busy || locked}
                  >
                    <Avatar id={person.staffUserId} name={person.staffName} />
                    <div>
                      <b>{person.staffName}</b>
                      {locked ? (
                        <span className={cx(ui.pill, ui.bad)}>
                          <Icon name="lock" />
                          PIN locked ·{" "}
                          {Math.ceil(person.lockRemainingMs / 60_000)} min
                        </span>
                      ) : (
                        <span className={cx(ui.pill, ui.ok)}>
                          <Icon name="check" />
                          Ready offline
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
            {staff.people.length === 0 && (
              <div
                className={cx(ui.note, ui.noteBad, signIn.note)}
                role="alert"
              >
                <Icon name="alert-triangle" />
                <div>
                  Nobody is prepared for offline selling on this counter.
                  Selling waits for the connection.
                </div>
              </div>
            )}
          </div>
          {selected && (
            <div className={signIn.pin}>
              <Avatar
                id={selected.staffUserId}
                name={selected.staffName}
                className={signIn.big}
              />
              <h3>{selected.staffName}</h3>
              <p>Enter your PIN</p>
              <PinPad
                value={pin}
                onChange={setPin}
                onSubmit={submit}
                submitLabel="Sign in"
                busy={busy}
              />
              <ErrorLine error={error} />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/** Opening your own shift offline: count the drawer, then your PIN. It's a journal entry. */
function OfflineOpenShift({ onOpened }: { onOpened: () => void }) {
  const [entry, setEntry] = useState<DrawerEntry>({});
  const [pin, setPin] = useState("");
  const form = useRef<HTMLFormElement>(null);
  const { busy, error, run } = useAction();
  const count = counted(entry) ? drawerCount(entry) : null;
  const ready = Boolean(count) && PIN_OK.test(pin) && !busy;
  useKeyBinding("Ctrl+Enter", () => clickSubmit(form.current), {
    enabled: ready,
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!count || !ready) return;
    const entered = pin;
    setPin("");
    void run(
      () => window.pos.offlineOpenShift({ pin: entered, count }),
      onOpened,
    );
  }

  return (
    <div className={styles.center}>
      <form ref={form} className={cx(ui.panel, cash.count)} onSubmit={submit}>
        <div className={cash.cntH}>
          <div className={ui.eyebrow}>Open your shift</div>
          <h2>Count the drawer</h2>
          <p>
            Count every note and coin you start with. The opening is saved on
            this counter and uploads with the sales.
          </p>
        </div>
        <DrawerTable
          entry={entry}
          onChange={setEntry}
          disabled={busy}
          autoFocus
        />
        <div className={cash.tot3}>
          <div>
            <small>Counted</small>
            <b>{count ? money(count.totalMinor) : "—"}</b>
          </div>
        </div>
        <div className={cx(ui.f, cash.field)}>
          <label htmlFor="offline-shift-pin">Your PIN</label>
          <input
            id="offline-shift-pin"
            className={ui.in}
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={8}
            value={pin}
            disabled={busy}
            onChange={(event) =>
              setPin(event.target.value.replace(/\D/g, "").slice(0, 8))
            }
          />
        </div>
        <div className={cash.err}>
          <ErrorLine error={error} />
        </div>
        <div className={ui.dfoot}>
          <span className={ui.grow} />
          <button
            type="submit"
            className={cx(ui.btn, ui.primary, ui.lg)}
            disabled={!ready}
          >
            <Icon name="wallet" />
            Open my shift
            <KeyHint keys="Ctrl+Enter" onPrimary small />
          </button>
        </div>
      </form>
    </div>
  );
}

type CartLine = { snapshotLineId: string; quantity: number };

/** Offline Sell: last-known stock, cash, and a normal receipt with a final number. */
export function OfflineSell({
  mode,
  staff,
  printer,
  onSold,
}: {
  mode: OfflineModeState;
  staff: OfflineStaff;
  printer: Printer | null | undefined;
  onSold: () => void;
}) {
  const now = useNow();
  const [stock, setStock] = useState<OfflineStockLine[] | null>(null);
  const [query, setQuery] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [cashIn, setCashIn] = useState("");
  const [draftId, setDraftId] = useState(() => crypto.randomUUID());
  const [receipt, setReceipt] = useState<OfflineReceiptView | null>(null);
  const [lastSale, setLastSale] = useState<OfflineReceiptView | null>(null);
  const [printMessage, setPrintMessage] = useState<string | null>(null);
  const { busy, error, run, clear } = useAction();
  const searchRef = useRef<HTMLInputElement>(null);

  const loadStock = useCallback(() => {
    void window.pos.offlineStock().then((result) => {
      if (result.ok) setStock(result.value);
    });
  }, []);
  useEffect(loadStock, [loadStock]);

  // The cart is priced by main from the signed snapshot, never here.
  useEffect(() => {
    if (!cart.length) {
      setQuote(null);
      return;
    }
    let live = true;
    void window.pos.offlineQuote({ items: cart }).then((result) => {
      if (live && result.ok) setQuote(result.value);
    });
    return () => {
      live = false;
    };
  }, [cart]);

  const results = useMemo(
    () => findOfflineLines(stock ?? [], query),
    [stock, query],
  );
  const byId = useMemo(
    () => new Map((stock ?? []).map((line) => [line.snapshotLineId, line])),
    [stock],
  );
  const totalMinor = quote?.totalMinor ?? 0;
  const tenderedMinor = cashIn ? minor(cashIn) : 0;
  const blocked = quote?.blocked ?? [];
  const hours = hoursBlock(staff.hours);
  const short = tenderedMinor < totalMinor;
  const canComplete =
    !busy &&
    cart.length > 0 &&
    quote !== null &&
    blocked.length === 0 &&
    !short &&
    !hours;

  function add(line: OfflineStockLine) {
    if (line.blocked) return;
    clear();
    setCart((items) => {
      const found = items.find((i) => i.snapshotLineId === line.snapshotLineId);
      return found
        ? items.map((i) =>
            i === found ? { ...i, quantity: i.quantity + 1 } : i,
          )
        : [...items, { snapshotLineId: line.snapshotLineId, quantity: 1 }];
    });
    setSelected(line.snapshotLineId);
    setQuery("");
    searchRef.current?.focus();
  }

  function setQty(id: string, quantity: number) {
    setCart((items) =>
      quantity <= 0
        ? items.filter((i) => i.snapshotLineId !== id)
        : items.map((i) => (i.snapshotLineId === id ? { ...i, quantity } : i)),
    );
  }

  function complete() {
    if (!canComplete) return;
    void run(
      () =>
        window.pos.offlineCommitSale({
          checkoutDraftId: draftId,
          items: cart,
          cashTenderedMinor: tenderedMinor,
        }),
      (sold) => {
        setReceipt(sold);
        setLastSale(sold);
        setPrintMessage(null);
        setCart([]);
        setCashIn("");
        setSelected(null);
        setDraftId(crypto.randomUUID());
        loadStock();
        onSold();
      },
    );
  }

  async function print(sale: OfflineReceiptView) {
    if (!printer) return;
    const result = await window.pos.printOfflineReceipt({
      saleCommandId: sale.saleCommandId,
      printerName: printer.name,
    });
    setPrintMessage(
      result.ok
        ? "Receipt sent to the printer."
        : (result.error ?? "The receipt did not print."),
    );
  }

  const selectedQty =
    cart.find((i) => i.snapshotLineId === selected)?.quantity ?? 0;
  useKeyBinding("F6", () => searchRef.current?.focus());
  useKeyBinding(["F12", "Ctrl+Enter"], () => complete(), {
    enabled: canComplete,
  });
  useKeyBinding("Escape", () => setReceipt(null), {
    enabled: Boolean(receipt),
  });
  // + / − / Del change the selected line; in a field they type, except in an empty search field.
  useKeyBinding(
    ["Plus", "Minus", "Delete"],
    (event) => {
      if (!selected || receipt) return false;
      if (
        inField(event.target) &&
        !(event.target === searchRef.current && query === "")
      )
        return false;
      if (event.key === "Delete") setQty(selected, 0);
      else setQty(selected, selectedQty + (event.key === "+" ? 1 : -1));
    },
    { inFields: true, repeat: true },
  );

  const quick = quickTenders(totalMinor);
  return (
    <div className={cx(s.sell, styles.sell)} aria-label="Sell offline">
      <div className={cx(ui.note, styles.banner)} role="status">
        <Icon name="info" />
        <div>
          <b>Selling from last-known stock</b>
          <div>{sellingBanner(mode, now)}</div>
        </div>
      </div>
      {hours && (
        <div className={cx(ui.note, ui.noteWarn, styles.banner)} role="alert">
          <Icon name="clock" />
          <div>{hours}</div>
        </div>
      )}
      {lastSale && receipt === null && (
        <div className={cx(ui.note, styles.banner)} role="status">
          <Icon name="check-circle" />
          <div>
            <b>Sale saved on this counter</b>
            <div>
              Receipt {lastSale.receiptNumber} is saved here and uploads when
              the server is reachable. Reprinting doesn&apos;t make a new sale.
            </div>
          </div>
        </div>
      )}
      <div className={s.grid}>
        <section className={cx(ui.panel, s.find)} aria-label="Find a product">
          <div className={s.findTop}>
            <form
              className={s.search}
              role="search"
              onSubmit={(event) => {
                event.preventDefault();
                const first = results.find((line) => !line.blocked);
                if (first) add(first);
              }}
            >
              <Icon name="search" />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search ordinary items, or scan a barcode"
                aria-label="Search offline stock"
                autoFocus
                autoComplete="off"
              />
              <KeyHint keys="F6" small />
            </form>
          </div>
          {stock === null ? (
            <p className={s.findEmpty}>Loading the saved stock…</p>
          ) : !query.trim() ? (
            <p className={s.findEmpty}>
              Only ordinary items in the saved stock can be sold offline.
              Prescription and controlled items need an online check.
            </p>
          ) : (
            <ul className={s.results}>
              {results.map((line) => (
                <li key={line.snapshotLineId}>
                  <button
                    type="button"
                    className={s.res}
                    onClick={() => add(line)}
                    disabled={Boolean(line.blocked)}
                  >
                    <div className={s.resMain}>
                      <div className={s.resName}>{offlineLineName(line)}</div>
                      <div className={s.resMeta}>
                        {[
                          line.display?.batchNo
                            ? `Batch ${line.display.batchNo}`
                            : null,
                          expiryText(line.sellBefore),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    </div>
                    <div className={s.resSide}>
                      <div className={s.price}>
                        Rs {money(line.unitPriceMinor)}
                      </div>
                      <div className={cx(s.stock, line.blocked && s.stockNone)}>
                        {line.blocked
                          ? blockedText(line.blocked, line.remaining)
                          : remainingText(line.remaining)}
                      </div>
                    </div>
                  </button>
                </li>
              ))}
              {results.length === 0 && (
                <p className={s.findEmpty}>
                  Nothing in the saved stock matches.
                </p>
              )}
            </ul>
          )}
        </section>

        <section className={cx(ui.panel, s.ticket)} aria-label="Current sale">
          <div className={cx(ui.ph, s.ticketH)}>
            <h2>Current sale</h2>
            <span className={ui.grow} />
            <button
              type="button"
              className={cx(ui.btn, ui.ghost)}
              onClick={() => {
                setCart([]);
                setSelected(null);
                setCashIn("");
              }}
              disabled={busy || !cart.length}
            >
              <Icon name="trash" />
              Clear
            </button>
          </div>
          <div className={s.thead} aria-hidden="true">
            <span>#</span>
            <span>Item</span>
            <span className={s.c}>Qty</span>
            <span className={s.r}>Price</span>
            <span className={s.r}>Amount</span>
          </div>
          <div className={s.lines}>
            {cart.length === 0 && (
              <div className={s.ticketEmpty}>
                <Icon name="shopping-cart" />
                <b>No items yet</b>
                Search the saved stock on the left to start a sale.
              </div>
            )}
            {cart.map((item, i) => {
              const line = byId.get(item.snapshotLineId);
              const priced = quote?.lines.find(
                (l) => l.snapshotLineId === item.snapshotLineId,
              );
              const refused = blocked.find(
                (b) => b.snapshotLineId === item.snapshotLineId,
              );
              const sel = item.snapshotLineId === selected;
              const unit = line?.unitPriceMinor ?? priced?.unitPriceMinor ?? 0;
              return (
                <div
                  key={item.snapshotLineId}
                  className={cx(s.ln, sel && s.sel)}
                  onClick={() => setSelected(item.snapshotLineId)}
                >
                  <span className={s.n}>{i + 1}</span>
                  <div>
                    <div className={s.nm}>
                      {line ? offlineLineName(line) : "Item"}
                    </div>
                    <div className={s.mt}>
                      {refused ? (
                        <span className={cx(ui.pill, ui.bad, s.linePill)}>
                          {blockedText(refused.reason, refused.remaining)}
                        </span>
                      ) : (
                        <span>
                          {[
                            line?.display?.batchNo
                              ? `Batch ${line.display.batchNo}`
                              : null,
                            line ? remainingText(line.remaining) : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className={s.qty}>
                    {sel ? (
                      <span className={s.stepper}>
                        <button
                          type="button"
                          onClick={() =>
                            setQty(item.snapshotLineId, item.quantity - 1)
                          }
                          aria-label={
                            item.quantity === 1 ? "Remove" : "One less"
                          }
                        >
                          <Icon name="minus" />
                        </button>
                        <input
                          type="number"
                          min={0}
                          value={item.quantity}
                          onChange={(event) =>
                            setQty(
                              item.snapshotLineId,
                              Number(event.target.value),
                            )
                          }
                          aria-label="Quantity"
                        />
                        <button
                          type="button"
                          onClick={() =>
                            setQty(item.snapshotLineId, item.quantity + 1)
                          }
                          aria-label="One more"
                        >
                          <Icon name="plus" />
                        </button>
                      </span>
                    ) : (
                      item.quantity
                    )}
                  </div>
                  <span className={cx(s.pr, s.r)}>{money(unit)}</span>
                  <span className={cx(s.am, s.r)}>
                    {money(priced?.lineTotalMinor ?? unit * item.quantity)}
                  </span>
                </div>
              );
            })}
          </div>
        </section>

        <section
          className={cx(ui.panel, s.pay, s.payPanel)}
          aria-label="Payment"
        >
          <div>
            <div className={s.dueL}>Total to pay</div>
            <div className={s.dueV}>
              <small>Rs</small>
              {money(totalMinor)}
            </div>
            {quote && (
              <dl className={s.brk}>
                <dt>Subtotal</dt>
                <dd>{money(quote.subtotalMinor)}</dd>
                <dt>VAT</dt>
                <dd>{money(quote.taxMinor)}</dd>
              </dl>
            )}
          </div>
          <div className={s.methods} role="group" aria-label="Payment method">
            <button type="button" className={s.m} aria-pressed>
              <Icon name="banknote" />
              Cash
            </button>
            <button
              type="button"
              className={s.m}
              disabled
              title="Not available offline yet"
            >
              <Icon name="credit-card" />
              Card
            </button>
            <button
              type="button"
              className={s.m}
              disabled
              title="Not available offline yet"
            >
              <Icon name="split" />
              Split
            </button>
          </div>
          <div>
            <label className={s.fldL} htmlFor="offline-cash">
              Cash received
            </label>
            <div className={s.moneyIn}>
              <small>Rs</small>
              <input
                id="offline-cash"
                inputMode="decimal"
                autoComplete="off"
                value={cashIn}
                onChange={(event) => setCashIn(moneyInput(event.target.value))}
                placeholder="0.00"
              />
            </div>
            {quick.length > 0 && (
              <div className={s.tender}>
                {[totalMinor, ...quick].map((amount, i) => (
                  <button
                    key={amount}
                    type="button"
                    aria-pressed={cashIn !== "" && minor(cashIn) === amount}
                    onClick={() => setCashIn(plainMoney(amount))}
                  >
                    {i === 0 ? "Exact" : money(amount).replace(/\.00$/, "")}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className={cx(s.change, cart.length > 0 && short && s.short)}>
            {cart.length > 0 && short ? (
              <>
                <span>Still to pay</span>
                <b>Rs {money(totalMinor - tenderedMinor)}</b>
              </>
            ) : (
              <>
                <span>Change to give</span>
                <b>Rs {money(Math.max(0, tenderedMinor - totalMinor))}</b>
              </>
            )}
          </div>
          <div className={styles.offRows}>
            {(
              [
                ["tag", "Discount", "F9"],
                ["pause", "Hold", "F8"],
              ] as [IconName, string, string][]
            ).map(([icon, label, key]) => (
              <div key={label} className={styles.offRow}>
                <Icon name={icon} />
                <b>{label}</b>
                <KeyHint keys={key} small />
                <span className={ui.grow} />
                <span className={ui.muted}>Needs an online connection</span>
              </div>
            ))}
          </div>
          {lastSale && (
            <div className={styles.lastSale}>
              <small>Last sale</small>
              <span className={ui.mono}>{lastSale.receiptNumber}</span>
              <span>
                Rs {money(lastSale.totalMinor)} ·{" "}
                {time(new Date(lastSale.soldAt))}
              </span>
              <div className={styles.lastRow}>
                <span className={cx(ui.pill, ui.info)}>Pending upload</span>
                <button
                  type="button"
                  className={cx(ui.btn, ui.outline, ui.sm)}
                  onClick={() => void print(lastSale)}
                  disabled={!printer}
                >
                  <Icon name="printer" />
                  Reprint
                </button>
              </div>
            </div>
          )}
          <div className={s.payActions}>
            <div className={s.payMsg}>
              <ErrorLine error={error} />
              {printMessage && <p role="status">{printMessage}</p>}
            </div>
            <button
              type="button"
              className={cx(ui.btn, ui.primary, s.xl)}
              onClick={complete}
              disabled={!canComplete}
            >
              <Icon name="check-circle" />
              {busy ? "Saving…" : "Complete sale"}
              <KeyHint keys="F12" small onPrimary />
            </button>
          </div>
        </section>
      </div>
      {receipt && (
        <div className={styles.scrim} onClick={() => setReceipt(null)}>
          <OfflineReceipt
            receipt={receipt}
            branch={null}
            onPrint={printer ? () => void print(receipt) : null}
            onClose={() => setReceipt(null)}
          />
        </div>
      )}
    </div>
  );
}

/** The customer's receipt: the same as an online one, with no offline wording (v2). */
function OfflineReceipt({
  receipt,
  branch,
  onPrint,
  onClose,
}: {
  receipt: OfflineReceiptView;
  branch: string | null;
  onPrint: (() => void) | null;
  onClose: () => void;
}) {
  const cashPay = receipt.payments.find((p) => p.method === "cash");
  return (
    <div
      className={cx(ui.panel, styles.receipt)}
      role="dialog"
      aria-label={`Receipt ${receipt.receiptNumber}`}
      onClick={(event) => event.stopPropagation()}
    >
      <div className={styles.rHead}>
        {branch && <b>{branch}</b>}
        <span>
          {new Intl.DateTimeFormat("en-GB", {
            day: "numeric",
            month: "short",
            year: "numeric",
          }).format(new Date(receipt.soldAt))}
          , {time(new Date(receipt.soldAt))}
        </span>
        <span>Cashier {receipt.sellerName}</span>
      </div>
      <div className={styles.rRow}>
        <span>Receipt</span>
        <b className={ui.mono}>{receipt.receiptNumber}</b>
      </div>
      <div className={styles.rLines}>
        {receipt.lines.map((line) => (
          <div key={line.snapshotLineId} className={styles.rRow}>
            <span>
              {line.quantity} ×{" "}
              {line.display
                ? offlineLineName({
                    display: line.display,
                    batchId: line.batchId,
                  })
                : "Item"}
            </span>
            <span>{money(line.lineTotalMinor)}</span>
          </div>
        ))}
      </div>
      <div className={styles.rRow}>
        <b>Total</b>
        <b>Rs {money(receipt.totalMinor)}</b>
      </div>
      {cashPay && cashPay.method === "cash" && (
        <>
          <div className={styles.rRow}>
            <span>Cash</span>
            <span>{money(cashPay.tenderedMinor)}</span>
          </div>
          <div className={styles.rRow}>
            <span>Change</span>
            <span>{money(receipt.changeMinor)}</span>
          </div>
        </>
      )}
      <p className={styles.rThanks}>Thank you · Prices include tax</p>
      <div className={ui.dfoot}>
        {onPrint && (
          <button
            type="button"
            className={cx(ui.btn, ui.outline)}
            onClick={onPrint}
          >
            <Icon name="printer" />
            Print
          </button>
        )}
        <span className={ui.grow} />
        <button
          type="button"
          className={cx(ui.btn, ui.primary)}
          onClick={onClose}
        >
          New sale
          <KeyHint keys="Escape" small onPrimary />
        </button>
      </div>
    </div>
  );
}

const BLOCKED: [string, string][] = [
  [
    "Refunds and voids",
    "Completed sales stay as they are until this counter is online. A refund is done at the branch, online.",
  ],
  [
    "Prescription and controlled items",
    "The offline stock is ordinary, non-prescription, non-controlled items only.",
  ],
  [
    "Discounts and price overrides",
    "The saved prices and tax are used. F9 is off.",
  ],
  [
    "Holding a sale",
    "Held sales live on the server. Finish the sale, or clear it.",
  ],
  [
    "Supplier payouts and stock changes",
    "Receiving, write-offs, transfers, stocktakes and cash payouts need an online counter.",
  ],
  [
    "New staff, PIN setup or reset",
    "Prepared staff can still sign in with their own PIN. New accounts need the server.",
  ],
];

const PAGE_TITLES: Partial<Record<Page, string>> = {
  returns: "Refunds need an online connection",
  cash: "Cash & shift needs an online connection",
  stock: "Stock changes need an online connection",
  counter: "This counter's settings need an online connection",
};

/** Every page but Sell while offline: what waits for the connection, and what still works. */
function OfflineBlocked({ page }: { page: Page }) {
  return (
    <div className={styles.blocked}>
      <div className={cx(ui.note, ui.noteBad, styles.banner)} role="alert">
        <Icon name="wifi-off" />
        <div>
          <b>{PAGE_TITLES[page] ?? "This needs an online connection"}</b>
          <div>
            Sales saved here are kept. This opens again once the counter is back
            online.
          </div>
        </div>
      </div>
      <ul className={styles.list}>
        {BLOCKED.map(([title, text]) => (
          <li key={title}>
            <Icon name="x" />
            <b>{title}</b>
            <span>{text}</span>
          </li>
        ))}
        <li>
          <Icon name="check" />
          <b>Still allowed</b>
          <span>
            Ordinary cash sales from the saved stock, opening your shift, and
            signing in with your own PIN.
          </span>
        </li>
      </ul>
    </div>
  );
}
