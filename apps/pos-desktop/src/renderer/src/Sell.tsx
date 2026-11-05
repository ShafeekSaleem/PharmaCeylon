import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";
import type {
  CatalogProduct,
  CheckoutDraftView,
  CompletedSale,
  CustomerView,
  HeldCart,
  PrescriptionView,
  Printer,
  Tender,
} from "../../shared/ipc-contract";
import { saleTotalMinor } from "../../shared/sale-total";
import { PrescriptionSheet, type RxLine } from "./Dispensing";
import { time } from "./format";
import { Icon } from "./Icon";
import { invoke, moneyInput } from "./invoke";
import { KeyHint } from "./KeyHint";
import { inField, KeyScope, SCAN_GAP_MS, useKeyBinding } from "./keymap";
import s from "./Sell.module.css";
import {
  FIND_FILTERS,
  findProducts,
  highlight,
  isSlmcRefusal,
  minor,
  money,
  moveSelection,
  plainMoney,
  quickTenders,
  scannedProduct,
  slmcRefusal,
  stockText,
  type FindFilter,
  type SlmcRefusal,
} from "./sell-model";
import { Avatar } from "./Shell";
import ui from "./ui.module.css";
import { cx } from "./useAction";

type Line = { product: CatalogProduct; qty: number };
type Method = "cash" | "card" | "split";

const productName = (p: CatalogProduct) =>
  p.strength && !p.name.includes(p.strength)
    ? `${p.name} ${p.strength}`
    : p.name;

/**
 * Sales sent but not confirmed: they can only be confirmed with the server, never sent again.
 * Anyone signed in here can confirm one. Its seller's confirmation resends it under their own key;
 * anyone else's only looks it up, so it stays the seller's sale and needs no co-sign PIN.
 */
function PendingCheckouts({
  reloadKey,
  onResolved,
  onCount,
}: {
  reloadKey: number;
  onResolved: (sale: CompletedSale) => void;
  onCount: (count: number) => void;
}) {
  const [drafts, setDrafts] = useState<CheckoutDraftView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pins, setPins] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    void window.pos
      .pendingCheckouts()
      .then((list) => {
        setDrafts(list);
        onCount(list.length);
      })
      .catch(() => undefined);
  }, [onCount]);
  useEffect(load, [load, reloadKey]);
  if (!drafts.length) return null;
  async function confirm(draft: CheckoutDraftView) {
    setError(null);
    setBusy(true);
    const pin = draft.ownSale ? pins[draft.draftId] : undefined;
    const result = await invoke(() =>
      window.pos.retryCheckout({
        draftId: draft.draftId,
        ...(draft.coSignerId && pin
          ? { coSign: { approverUserId: draft.coSignerId, pin } }
          : {}),
      }),
    );
    setBusy(false);
    setPins((current) => ({ ...current, [draft.draftId]: "" }));
    if (result.ok) onResolved(result.value);
    else setError(result.error.message);
    load();
  }
  return (
    <div className={cx(ui.note, ui.noteBad, s.ticketNote)} role="alert">
      <Icon name="alert-triangle" />
      <div>
        <b>
          {drafts.length === 1 ? "A sale was" : `${drafts.length} sales were`}{" "}
          sent but not confirmed.
        </b>{" "}
        Confirm before taking payment again — confirming never charges twice.
        <ul>
          {drafts.map((d) => (
            <li key={d.draftId}>
              <span>
                {d.lineCount} item{d.lineCount === 1 ? "" : "s"}, about{" "}
                {d.estimatedTotal}, {time(new Date(d.createdAt))}
                {d.ownSale
                  ? " · rung up by you"
                  : ` · started by ${d.staffName ?? "someone who has signed out"}. Confirming looks it up; it stays their sale`}
              </span>
              {d.ownSale && d.coSignerId && (
                <input
                  type="password"
                  autoComplete="off"
                  className={ui.in}
                  aria-label="Co-signing pharmacist's PIN"
                  placeholder="Pharmacist PIN, if asked"
                  value={pins[d.draftId] ?? ""}
                  onChange={(e) =>
                    setPins((current) => ({
                      ...current,
                      [d.draftId]: e.target.value,
                    }))
                  }
                />
              )}
              <button
                type="button"
                className={cx(ui.btn, ui.outline, ui.sm)}
                onClick={() => void confirm(d)}
                disabled={busy}
              >
                Confirm with server
              </button>
            </li>
          ))}
        </ul>
        {error && <p className={ui.badText}>{error}</p>}
      </div>
    </div>
  );
}

/** The customer on the sale: shown, changed or searched for in place. */
function CustomerStrip({
  customer,
  onChange,
  searching,
  onSearching,
  inputRef,
  onOpen,
}: {
  customer: CustomerView | null;
  onChange: (customer: CustomerView | null) => void;
  searching: boolean;
  onSearching: (searching: boolean) => void;
  inputRef: RefObject<HTMLInputElement>;
  onOpen: () => void;
}) {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<CustomerView[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Closed from outside too (Esc on Sell): start the next search empty.
  useEffect(() => {
    if (searching) return;
    setFound([]);
    setQuery("");
    setError(null);
  }, [searching]);

  async function search(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!query.trim()) return;
    const result = await invoke(() => window.pos.searchCustomers({ q: query }));
    if (result.ok) setFound(result.value);
    else setError(result.error.message);
  }

  function close() {
    onSearching(false);
    setFound([]);
    setQuery("");
    setError(null);
  }

  if (searching)
    return (
      <form className={s.cust} onSubmit={search} role="search">
        <span className={s.walkIn}>
          <Icon name="search" />
        </span>
        <div className={s.custSearch}>
          <input
            ref={inputRef}
            className={ui.in}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Customer name or phone, then Enter"
            aria-label="Find a customer"
          />
          <button type="submit" className={cx(ui.btn, ui.outline)}>
            Find
          </button>
          <button
            type="button"
            className={cx(ui.btn, ui.ghost, s.iconBtn)}
            onClick={close}
            aria-label="Cancel"
          >
            <Icon name="x" />
          </button>
        </div>
        {(found.length > 0 || error) && (
          <ul className={s.custFound}>
            {found.map((c) => (
              <li key={c.customerId}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(c);
                    close();
                  }}
                >
                  {c.fullName}
                  <span>{c.phone ?? ""}</span>
                </button>
              </li>
            ))}
            {error && <li className={ui.badText}>{error}</li>}
          </ul>
        )}
      </form>
    );

  return (
    <div className={s.cust}>
      {customer ? (
        <Avatar id={customer.customerId} name={customer.fullName} />
      ) : (
        <span className={s.walkIn}>
          <Icon name="user" />
        </span>
      )}
      <div>
        <b>{customer ? customer.fullName : "Walk-in customer"}</b>
        <small>
          {customer
            ? (customer.phone ?? "No phone on file")
            : "Add a customer to find their prescriptions"}
        </small>
      </div>
      <span className={ui.grow} />
      {customer && (
        <button
          type="button"
          className={cx(ui.btn, ui.ghost, ui.sm)}
          onClick={() => onChange(null)}
        >
          Remove
        </button>
      )}
      <button
        type="button"
        className={cx(ui.btn, ui.outline, ui.sm)}
        onClick={onOpen}
      >
        {customer ? "Change customer" : "Add customer"}
        <KeyHint keys="F7" small />
      </button>
    </div>
  );
}

/**
 * Sell (screen=sell): find, the ticket and pay. Online checkout at this counter: prices and totals
 * are the server's; this only collects choices. Prescriptions are taken in the sheet over it.
 *
 * Keys (keymap.ts; the page's `<KeyScope>` is in App): F6 search, F7 customer, F8 hold, F10 the
 * prescription sheet, F12 or Ctrl+Enter complete, Esc closes what's open, ↑/↓ move through the
 * results, + / − / Del change the selected line, and number keys type into cash received. Focus
 * stays in the search field, so a barcode scan always lands there.
 */
export function Sell({
  onActivity,
  onCommandSent,
}: {
  onActivity?: () => void;
  onCommandSent?: () => void;
} = {}) {
  const [catalog, setCatalog] = useState<CatalogProduct[] | null>(null);
  const [vatRatePercent, setVatRatePercent] = useState(0);
  const [pendingKey, setPendingKey] = useState(0);
  // The cart whose sale may already have gone through: it can't be sent again, only confirmed
  // above or cleared to start a different sale.
  const [awaiting, setAwaiting] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FindFilter>("all");
  const [resultIndex, setResultIndex] = useState(0);
  const [lines, setLines] = useState<Line[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [method, setMethod] = useState<Method>("cash");
  const [cash, setCash] = useState("");
  const [card, setCard] = useState("");
  const [cardReference, setCardReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sale, setSale] = useState<CompletedSale | null>(null);
  const [lastSale, setLastSale] = useState<CompletedSale | null>(null);
  const [holds, setHolds] = useState<HeldCart[]>([]);
  const [menu, setMenu] = useState<"held" | "more" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [customer, setCustomer] = useState<CustomerView | null>(null);
  const [customerSearching, setCustomerSearching] = useState(false);
  const [prescription, setPrescription] = useState<PrescriptionView | null>(
    null,
  );
  const [approverId, setApproverId] = useState("");
  const [approverName, setApproverName] = useState("");
  const [pin, setPin] = useState("");
  const [sheetOpen, setSheetOpen] = useState(false);
  // The sheet opens by itself once per sale, when the first prescription item goes on.
  const [sheetOffered, setSheetOffered] = useState(false);
  const [refusal, setRefusal] = useState<SlmcRefusal | null>(null);
  const [refusedApproverIds, setRefusedApproverIds] = useState<string[]>([]);
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [printer, setPrinter] = useState("");
  const [printMessage, setPrintMessage] = useState<string | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  const cashRef = useRef<HTMLInputElement>(null);
  const customerRef = useRef<HTMLInputElement>(null);
  const pinRef = useRef<HTMLInputElement>(null);

  const rxProducts = lines.filter((l) => l.product.needsPharmacist);
  const needsPrescription = rxProducts.length > 0;
  const hasControlled = lines.some((l) => l.product.isControlled);
  const dispensing = {
    ...(customer ? { customerId: customer.customerId } : {}),
    ...(prescription && needsPrescription
      ? { prescriptionId: prescription.prescriptionId }
      : {}),
  };

  function resetSale() {
    setLines([]);
    setSelectedId(null);
    setCustomer(null);
    setCustomerSearching(false);
    setPrescription(null);
    setApproverId("");
    setApproverName("");
    setPin("");
    setMethod("cash");
    setCash("");
    setCard("");
    setCardReference("");
    setAwaiting(false);
    setSheetOpen(false);
    setSheetOffered(false);
    setRefusal(null);
  }

  const loadHolds = useCallback(() => {
    void invoke(() => window.pos.listHolds()).then((result) =>
      setHolds(result.ok ? result.value : []),
    );
  }, []);
  useEffect(loadHolds, [loadHolds]);

  // Windows' printers, reread after each sale so one plugged in since shows up. The choice stays.
  const loadPrinters = useCallback(() => {
    void window.pos
      .listPrinters()
      .then((list) => {
        setPrinters(list);
        setPrinter((current) =>
          list.some((p) => p.name === current)
            ? current
            : (list[0]?.name ?? ""),
        );
      })
      .catch(() => undefined);
  }, []);
  useEffect(loadPrinters, [loadPrinters]);

  const refresh = useCallback(() => {
    setError(null);
    void invoke(() => window.pos.catalog()).then((result) => {
      if (!result.ok) return setError(result.error.message);
      setCatalog(result.value.products);
      setVatRatePercent(result.value.vatRatePercent);
    });
  }, []);
  useEffect(refresh, [refresh]);

  const results = useMemo(
    () => findProducts(catalog ?? [], query, filter),
    [catalog, query, filter],
  );
  useEffect(() => setResultIndex(0), [query, filter]);

  const totals = saleTotalMinor(
    lines.map((l) => ({
      unitPriceMinor: minor(l.product.unitPrice),
      qty: l.qty,
    })),
    vatRatePercent,
  );
  const cashMinor = method !== "card" && cash ? minor(cash) : 0;
  const cardMinor =
    method === "card"
      ? totals.totalMinor
      : method === "split" && card
        ? minor(card)
        : 0;
  const tenderedMinor = cashMinor + cardMinor;
  const tenderShort = tenderedMinor < totals.totalMinor;
  const units = lines.reduce((sum, l) => sum + l.qty, 0);

  /** Closes the finished sale's receipt and refreshes stock, as "New sale" always has. */
  function dismissReceipt() {
    setSale(null);
    setPrintMessage(null);
    refresh();
    searchRef.current?.focus();
  }

  function add(product: CatalogProduct) {
    if (sale) dismissReceipt();
    setNotice(null);
    setLines((current) => {
      const existing = current.find(
        (l) => l.product.productId === product.productId,
      );
      if (existing)
        return current.map((l) =>
          l === existing
            ? { ...l, qty: Math.min(l.qty + 1, product.available) }
            : l,
        );
      return [...current, { product, qty: 1 }];
    });
    setSelectedId(product.productId);
    setQuery("");
    // Back to search for the next scan; a sheet that opens takes focus from there.
    searchRef.current?.focus();
    if (product.needsPharmacist && !prescription && !sheetOffered) {
      setSheetOffered(true);
      setSheetOpen(true);
    }
  }

  function setQty(productId: string, raw: number) {
    // Whole units only, never more than is available.
    const qty = Number.isFinite(raw) ? Math.floor(raw) : 0;
    setLines((current) =>
      qty <= 0
        ? current.filter((l) => l.product.productId !== productId)
        : current.map((l) =>
            l.product.productId === productId
              ? { ...l, qty: Math.min(qty, l.product.available) }
              : l,
          ),
    );
    if (qty <= 0 && selectedId === productId) setSelectedId(null);
  }

  // ---- counter actions (bound to keys below) ----

  function focusSearch() {
    searchRef.current?.focus();
    searchRef.current?.select();
  }

  function openCustomer() {
    setCustomerSearching(true);
  }
  useEffect(() => {
    if (customerSearching) customerRef.current?.focus();
  }, [customerSearching]);

  function moveResult(delta: number) {
    setResultIndex((i) => moveSelection(i, delta, results.length));
  }

  function changeQty(delta: number) {
    const line = lines.find((l) => l.product.productId === selectedId);
    if (line) setQty(line.product.productId, line.qty + delta);
  }

  function removeLine() {
    if (selectedId) setQty(selectedId, 0);
  }

  function openPharmacist() {
    if (!needsPrescription) return;
    setSheetOpen(true);
  }

  function closeSheet() {
    setSheetOpen(false);
  }

  // The sheet puts the PIN under the pharmacist's fingers when it opens on them or they're chosen.
  useEffect(() => {
    if (sheetOpen && approverId) pinRef.current?.focus();
  }, [sheetOpen, approverId]);

  // Leaving the sheet for payment puts the cursor in cash received, once the sheet has gone; closing
  // it any other way puts it back in search.
  const focusCashNext = useRef(false);
  const sheetWasOpen = useRef(false);
  useEffect(() => {
    if (sheetOpen) {
      sheetWasOpen.current = true;
      return;
    }
    if (!sheetWasOpen.current) return;
    sheetWasOpen.current = false;
    if (focusCashNext.current) cashRef.current?.focus();
    else searchRef.current?.focus();
    focusCashNext.current = false;
  }, [sheetOpen]);

  // Closing the customer search puts the cursor back in search.
  const customerWasSearching = useRef(false);
  useEffect(() => {
    if (customerSearching) customerWasSearching.current = true;
    else if (customerWasSearching.current) {
      customerWasSearching.current = false;
      searchRef.current?.focus();
    }
  }, [customerSearching]);

  function continueToPayment() {
    focusCashNext.current = true;
    setSheetOpen(false);
    setRefusal(null);
  }

  async function hold() {
    if (busy || awaiting || !lines.length) return;
    setError(null);
    const result = await invoke(() =>
      window.pos.holdCart({
        lines: lines.map((l) => ({
          productId: l.product.productId,
          qty: l.qty,
        })),
        dispensing,
      }),
    );
    if (result.ok) {
      resetSale();
      setNotice(`Held as ${result.value.holdRef}.`);
      loadHolds();
      searchRef.current?.focus();
    } else setError(result.error.message);
  }

  async function recall(holdId: string) {
    setMenu(null);
    setError(null);
    // Recalling claims the hold on the server, so price it against a fresh product list first:
    // lines that can't be matched would otherwise be lost with the hold.
    const fresh = await invoke(() => window.pos.catalog());
    if (!fresh.ok) return setError(fresh.error.message);
    setCatalog(fresh.value.products);
    setVatRatePercent(fresh.value.vatRatePercent);
    const result = await invoke(() => window.pos.recallHold({ holdId }));
    loadHolds();
    if (!result.ok) return setError(result.error.message);
    if (sale) dismissReceipt();
    const byId = new Map(fresh.value.products.map((p) => [p.productId, p]));
    const held = result.value;
    setCustomer(held.customer);
    setPrescription(held.prescription);
    const restored = held.lines.flatMap((l) => {
      const product = byId.get(l.productId);
      return product && product.available > 0
        ? [{ product, qty: Math.min(l.qty, product.available) }]
        : [];
    });
    setLines(restored);
    setSelectedId(restored[0]?.product.productId ?? null);
    searchRef.current?.focus();
    const short = held.lines.length - restored.length;
    setNotice(
      short > 0
        ? `${short} held item${short === 1 ? " is" : "s are"} out of stock and ${short === 1 ? "was" : "were"} left out.`
        : null,
    );
  }

  function tender(): Tender {
    if (method === "card")
      return { cardAmount: plainMoney(totals.totalMinor), cardReference };
    if (method === "split")
      return {
        ...(cash ? { cashAmount: cash } : {}),
        ...(card ? { cardAmount: card, cardReference } : {}),
      };
    return cash ? { cashAmount: cash } : {};
  }

  async function complete() {
    if (awaiting || busy || !lines.length || tenderShort) return;
    // Prescription items need one linked first: take the person to the sheet rather than refuse.
    if (needsPrescription && (!prescription || prescription.expired)) {
      setSheetOpen(true);
      return;
    }
    if (hasControlled && approverId && pin.length < 4) {
      setError("Ask the pharmacist to enter their PIN.");
      setSheetOpen(true);
      return;
    }
    setBusy(true);
    setError(null);
    setRefusal(null);
    try {
      const result = await invoke(() =>
        window.pos.submitCheckout({
          lines: lines.map((l) => ({
            productId: l.product.productId,
            qty: l.qty,
          })),
          tender: tender(),
          dispensing,
          ...(hasControlled && approverId
            ? { coSign: { approverUserId: approverId, pin } }
            : {}),
        }),
      );
      // The PIN is good for one attempt; never leave it sitting in the form.
      setPin("");
      if (result.ok) {
        setSale(result.value);
        setLastSale(result.value);
        setPrintMessage(null);
        resetSale();
        loadPrinters();
      } else if (isSlmcRefusal(result.error.code)) {
        // Final refusals (desktop main doesn't keep the sale pending): say what to do in the sheet.
        setRefusal(
          slmcRefusal(result.error.code, result.error.message, approverName),
        );
        if (result.error.code === "APPROVER_NOT_QUALIFIED" && approverId)
          setRefusedApproverIds((ids) => [...new Set([...ids, approverId])]);
        setSheetOpen(true);
      } else {
        setError(result.error.message);
        if (result.error.code === "CHECKOUT_UNCERTAIN") setAwaiting(true);
      }
    } finally {
      setBusy(false);
      // Show any sale left unconfirmed straight away, with its confirm button.
      setPendingKey((k) => k + 1);
    }
  }

  async function print() {
    if (!sale) return;
    const result = await window.pos.printSaleReceipt({
      saleId: sale.saleId,
      printerName: printer,
    });
    setPrintMessage(
      result.ok
        ? "Receipt sent to the printer."
        : (result.error ?? "The receipt did not print."),
    );
  }

  // ---- keys (keymap.ts) ----
  const canHold = !busy && !awaiting && lines.length > 0;
  const canComplete = canHold && !tenderShort;
  useKeyBinding("F6", () => focusSearch());
  useKeyBinding("F7", () => openCustomer());
  useKeyBinding("F8", () => void hold(), { enabled: canHold });
  useKeyBinding("F10", () => openPharmacist(), { enabled: needsPrescription });
  useKeyBinding(["F12", "Ctrl+Enter"], () => void complete(), {
    enabled: canComplete,
  });
  useKeyBinding("Escape", () => {
    if (menu) return void setMenu(null);
    if (customerSearching) return void setCustomerSearching(false);
    if (query) return void setQuery("");
    return false;
  });
  // ↑/↓ move through the results from the search field (or with nothing focused), not from others.
  useKeyBinding(
    ["ArrowUp", "ArrowDown"],
    (event) => {
      if (inField(event.target) && event.target !== searchRef.current)
        return false;
      moveResult(event.key === "ArrowUp" ? -1 : 1);
    },
    { inFields: true, repeat: true },
  );
  // + / − / Del change the selected line. In a field they type, except in an empty search field,
  // which is where the cursor sits between scans.
  useKeyBinding(
    ["Plus", "Minus", "Delete"],
    (event) => {
      if (!selectedId) return false;
      if (
        inField(event.target) &&
        !(event.target === searchRef.current && query === "")
      )
        return false;
      if (event.key === "Delete") removeLine();
      else changeQty(event.key === "+" ? 1 : -1);
    },
    { inFields: true, repeat: true },
  );
  // A number key with no field focused. It goes into search first, because it may be the first
  // character of a barcode scan; if no scan follows it, it was a person keying the cash received,
  // and it moves there. A scan therefore never lands in cash.
  const digitToCash = useRef<number | null>(null);
  useEffect(() => () => window.clearTimeout(digitToCash.current ?? undefined), []);
  useKeyBinding("Digit", (event) => {
    const digit = event.key;
    const before = searchRef.current?.value ?? query;
    searchRef.current?.focus();
    setQuery(before + digit);
    if (sale || !lines.length || method === "card") return;
    window.clearTimeout(digitToCash.current ?? undefined);
    digitToCash.current = window.setTimeout(() => {
      digitToCash.current = null;
      const field = searchRef.current;
      if (!field || field.value !== before + digit) return; // a scan followed: leave it in search
      setQuery(before);
      setCash((current) => moneyInput(current + digit));
      cashRef.current?.focus();
    }, SCAN_GAP_MS * 3);
  });

  const onPendingCount = useCallback(
    (count: number) => {
      if (count === 0) setAwaiting(false);
      onActivity?.();
    },
    [onActivity],
  );

  function onSearch(event: FormEvent) {
    event.preventDefault();
    // A scanner types the barcode and Enter: add the exact match straight away.
    const exact = scannedProduct(catalog ?? [], query);
    const chosen = exact ?? results[resultIndex];
    if (chosen && chosen.available > 0) add(chosen);
  }

  const rxLines: RxLine[] = rxProducts.map((l) => ({
    productId: l.product.productId,
    name: productName(l.product),
    qty: l.qty,
    unit: l.product.unit,
  }));

  // ---- the pay panel's prescription box ----
  let rxBox: { ready: boolean; title: string; detail: string } | null = null;
  if (needsPrescription) {
    if (!prescription)
      rxBox = {
        ready: false,
        title: `${rxProducts.length} item${rxProducts.length === 1 ? " needs" : "s need"} a prescription`,
        detail: "Open the prescription sheet to link or record it.",
      };
    else if (prescription.expired)
      rxBox = {
        ready: false,
        title: "The prescription has expired",
        detail: `${prescription.rxNumber} can't be dispensed. Link another one.`,
      };
    else if (hasControlled && approverId && pin.length < 4)
      rxBox = {
        ready: false,
        title: "Pharmacist's PIN needed",
        detail: `${approverName || "The pharmacist"} enters their PIN to co-sign.`,
      };
    else
      rxBox = {
        ready: true,
        title: hasControlled ? "Ready to co-sign" : "Prescription linked",
        detail: `${prescription.rxNumber} · Dr ${prescription.doctorName}${
          hasControlled
            ? approverId
              ? ` · ${approverName || "the pharmacist"} co-signs as you complete`
              : " · you dispense the controlled items"
            : ""
        }`,
      };
  }

  const quick = quickTenders(totals.totalMinor);
  const cashBox = (
    <div>
      <label className={s.fldL} htmlFor="sell-cash">
        Cash received <KeyHint keys="Digit" small />
      </label>
      <div className={s.moneyIn}>
        <small>Rs</small>
        <input
          id="sell-cash"
          ref={cashRef}
          inputMode="decimal"
          autoComplete="off"
          value={cash}
          onChange={(e) => setCash(moneyInput(e.target.value))}
          placeholder="0.00"
        />
      </div>
      {method === "cash" && quick.length > 0 && (
        <div className={s.tender}>
          {[totals.totalMinor, ...quick].map((amount, i) => (
            <button
              key={amount}
              type="button"
              aria-pressed={cash !== "" && minor(cash) === amount}
              onClick={() => setCash(plainMoney(amount))}
            >
              {i === 0 ? "Exact" : money(amount).replace(/\.00$/, "")}
            </button>
          ))}
        </div>
      )}
    </div>
  );
  const referenceBox = (
    <input
      className={cx(ui.in, s.ref)}
      value={cardReference}
      onChange={(e) => setCardReference(e.target.value)}
      placeholder="Card approval reference"
      aria-label="Card approval reference"
      maxLength={128}
    />
  );

  return (
    <div className={s.sell} aria-label="Sell">
      <div className={s.grid}>
        {/* ---------- find ---------- */}
        <section className={cx(ui.panel, s.find)} aria-label="Find a product">
          <div className={s.findTop}>
            <form className={s.search} onSubmit={onSearch} role="search">
              <Icon name="barcode-scan" />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Scan, or type a name, SKU or barcode"
                aria-label="Scan or search"
                autoFocus
                autoComplete="off"
              />
              <KeyHint keys="F6" small />
            </form>
            <div className={s.chips} role="group" aria-label="Show">
              {FIND_FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className={s.chip}
                  aria-pressed={filter === f.id}
                  onClick={() => setFilter(f.id)}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
          {catalog === null && !error ? (
            <p className={s.findEmpty}>Loading products…</p>
          ) : !query.trim() ? (
            <p className={s.findEmpty}>
              Scan a barcode, or type part of a name. Enter adds the highlighted
              product.
            </p>
          ) : (
            <>
              <div className={s.resHead}>
                <span>
                  {results.length} match{results.length === 1 ? "" : "es"}
                </span>
                <span className={s.hint}>
                  <kbd className={s.key}>↑</kbd>
                  <kbd className={s.key}>↓</kbd> move ·{" "}
                  <kbd className={s.key}>Enter</kbd> add
                </span>
              </div>
              <ul className={s.results}>
                {results.map((p, i) => {
                  const name = highlight(productName(p), query);
                  const stock = stockText(p.available);
                  const sel = i === resultIndex;
                  return (
                    <li key={p.productId}>
                      <button
                        type="button"
                        className={cx(s.res, sel && s.sel)}
                        onClick={() => add(p)}
                        onMouseEnter={() => setResultIndex(i)}
                        disabled={p.available <= 0}
                      >
                        <div className={s.resMain}>
                          <div className={s.resName}>
                            <span>
                              {name.before}
                              {name.hit && <mark>{name.hit}</mark>}
                              {name.after}
                            </span>
                            {p.needsPharmacist && (
                              <span className={s.rx}>Rx</span>
                            )}
                          </div>
                          <div className={s.resMeta}>
                            {[
                              p.isControlled ? "Controlled" : null,
                              p.unit ? `per ${p.unit}` : null,
                              p.sku ? `SKU ${p.sku}` : null,
                            ]
                              .filter(Boolean)
                              .join(" · ") || " "}
                          </div>
                        </div>
                        <div className={s.resSide}>
                          <div className={s.price}>
                            Rs {money(minor(p.unitPrice))}
                            {p.unit && <small>/{p.unit}</small>}
                          </div>
                          <div
                            className={cx(
                              s.stock,
                              stock.tone === "ok" && s.stockOk,
                              stock.tone === "warn" && s.stockWarn,
                              stock.tone === "none" && s.stockNone,
                            )}
                          >
                            {stock.text}
                          </div>
                        </div>
                        {sel && p.available > 0 && (
                          <span className={s.enter}>
                            <Icon name="corner-down-left" />
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
              {results.length === 0 && (
                <p className={s.findEmpty}>
                  Nothing matches. Check the spelling, or try All.
                </p>
              )}
            </>
          )}
        </section>

        {/* ---------- ticket ---------- */}
        <section className={cx(ui.panel, s.ticket)} aria-label="Current sale">
          <div className={cx(ui.ph, s.ticketH)}>
            <h2>Current sale</h2>
            <span className={ui.grow} />
            <button
              type="button"
              className={cx(ui.btn, ui.ghost)}
              onClick={() => void hold()}
              disabled={busy || awaiting || !lines.length}
            >
              <Icon name="pause" />
              Hold <KeyHint keys="F8" small />
            </button>
            <button
              type="button"
              className={cx(ui.btn, ui.ghost)}
              onClick={() => setMenu(menu === "held" ? null : "held")}
              aria-expanded={menu === "held"}
            >
              <Icon name="archive" />
              Held <span className={s.count}>{holds.length}</span>
            </button>
            <button
              type="button"
              className={cx(ui.btn, ui.ghost, s.iconBtn)}
              onClick={() => setMenu(menu === "more" ? null : "more")}
              aria-expanded={menu === "more"}
              aria-label="More"
            >
              <Icon name="more-horizontal" />
            </button>
            {menu === "held" && (
              <div className={s.menu} role="menu" aria-label="Held sales">
                {holds.length === 0 && (
                  <p className={s.menuEmpty}>No sales are held.</p>
                )}
                {holds.map((h) => (
                  <div key={h.holdId} className={s.held}>
                    <div className={ui.grow}>
                      <b>
                        {h.holdRef}
                        {h.label ? ` · ${h.label}` : ""}
                      </b>
                      <small>
                        {h.itemCount} items · {h.total} · {h.heldBy}
                      </small>
                    </div>
                    <button
                      type="button"
                      className={cx(ui.btn, ui.outline, ui.sm)}
                      onClick={() => void recall(h.holdId)}
                      disabled={busy || lines.length > 0 || catalog === null}
                    >
                      Recall
                    </button>
                  </div>
                ))}
                {holds.length > 0 && lines.length > 0 && (
                  <p className={s.menuEmpty}>
                    Hold or clear the sale on screen to recall one.
                  </p>
                )}
              </div>
            )}
            {menu === "more" && (
              <div className={s.menu} role="menu">
                <button
                  type="button"
                  className={cx(ui.btn, ui.ghost)}
                  onClick={() => {
                    setMenu(null);
                    resetSale();
                  }}
                  disabled={busy || !lines.length}
                >
                  <Icon name="trash" />
                  Clear this sale
                </button>
                <button
                  type="button"
                  className={cx(ui.btn, ui.ghost)}
                  onClick={() => {
                    setMenu(null);
                    refresh();
                  }}
                  disabled={busy}
                >
                  <Icon name="refresh" />
                  Refresh products
                </button>
              </div>
            )}
          </div>
          <PendingCheckouts
            reloadKey={pendingKey}
            onCount={onPendingCount}
            onResolved={(resolved) => {
              setSale(resolved);
              setLastSale(resolved);
              // Confirming the sale that was on screen settles that cart.
              if (awaiting) resetSale();
            }}
          />
          <CustomerStrip
            customer={customer}
            onChange={setCustomer}
            searching={customerSearching}
            onSearching={setCustomerSearching}
            inputRef={customerRef}
            onOpen={openCustomer}
          />
          <div className={s.thead} aria-hidden="true">
            <span>#</span>
            <span>Item</span>
            <span className={s.c}>Qty</span>
            <span className={s.r}>Price</span>
            <span className={s.r}>Amount</span>
          </div>
          <div className={s.lines}>
            {lines.length === 0 && (
              <div className={s.ticketEmpty}>
                <Icon name="shopping-cart" />
                <b>No items yet</b>
                Scan a barcode or search on the left to start a sale.
              </div>
            )}
            {lines.map((l, i) => {
              const p = l.product;
              const sel = p.productId === selectedId;
              const linked = prescription && !prescription.expired;
              return (
                <div
                  key={p.productId}
                  className={cx(s.ln, sel && s.sel)}
                  onClick={() => setSelectedId(p.productId)}
                >
                  <span className={s.n}>{i + 1}</span>
                  <div>
                    <div className={s.nm}>{productName(p)}</div>
                    <div className={s.mt}>
                      {p.needsPharmacist && <span className={s.rx}>Rx</span>}
                      {p.needsPharmacist &&
                        (linked ? (
                          <span className={cx(ui.pill, ui.ok, s.linePill)}>
                            <Icon name="check" />
                            {prescription.rxNumber}
                          </span>
                        ) : (
                          <span className={cx(ui.pill, s.rxPill, s.linePill)}>
                            Needs prescription
                          </span>
                        ))}
                      {p.isControlled && (
                        <span className={cx(ui.pill, ui.warn, s.linePill)}>
                          Controlled · co-sign
                        </span>
                      )}
                      <span>
                        {[
                          p.unit ? `per ${p.unit}` : null,
                          `${p.available} available`,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </div>
                  </div>
                  <div className={s.qty}>
                    {sel ? (
                      <span className={s.stepper}>
                        <button
                          type="button"
                          onClick={() => setQty(p.productId, l.qty - 1)}
                          aria-label={
                            l.qty === 1 ? `Remove ${p.name}` : "One less"
                          }
                        >
                          <Icon name="minus" />
                        </button>
                        <input
                          type="number"
                          min={0}
                          max={p.available}
                          value={l.qty}
                          onChange={(e) =>
                            setQty(p.productId, Number(e.target.value))
                          }
                          aria-label={`Quantity of ${p.name}`}
                        />
                        <button
                          type="button"
                          onClick={() => setQty(p.productId, l.qty + 1)}
                          disabled={l.qty >= p.available}
                          aria-label="One more"
                        >
                          <Icon name="plus" />
                        </button>
                      </span>
                    ) : (
                      <>
                        {l.qty} {p.unit && <small>{p.unit}</small>}
                      </>
                    )}
                  </div>
                  <span className={cx(s.pr, s.r)}>
                    {money(minor(p.unitPrice))}
                  </span>
                  <span className={cx(s.am, s.r)}>
                    {money(minor(p.unitPrice) * l.qty)}
                  </span>
                </div>
              );
            })}
          </div>
          <div className={s.ticketFoot}>
            <span>
              <b>{lines.length}</b> line{lines.length === 1 ? "" : "s"} ·{" "}
              <b>{units}</b> unit{units === 1 ? "" : "s"}
            </span>
            <div className={s.keys}>
              <span>
                <kbd className={s.key}>+</kbd>
                <kbd className={s.key}>−</kbd> qty
              </span>
              <span>
                <kbd className={s.key}>Del</kbd> remove
              </span>
              <span>
                <kbd className={s.key}>F10</kbd> pharmacist
              </span>
            </div>
          </div>
        </section>

        {/* ---------- pay ---------- */}
        <section
          className={cx(ui.panel, s.pay, s.payPanel)}
          aria-label="Payment"
        >
          {sale ? (
            <>
              <div>
                <div className={cx(s.dueL, s.done)}>
                  <Icon name="check-circle" />
                  Sale complete ·{" "}
                  <span className={ui.mono}>{sale.invoiceNo}</span>
                </div>
                <div className={s.dueV}>
                  <small>Rs</small>
                  {money(minor(sale.grandTotal))}
                </div>
                <dl className={s.brk}>
                  <dt>Paid</dt>
                  <dd>{money(minor(sale.amountPaid))}</dd>
                  {sale.payments.map((p, i) => (
                    <SalePayment key={i} method={p.method} amount={p.amount} />
                  ))}
                </dl>
              </div>
              <div className={s.change}>
                <span>Change to give</span>
                <b>Rs {money(minor(sale.changeDue))}</b>
              </div>
              <div className={s.payActions}>
                {printers.length > 0 ? (
                  <div className={s.rcpt}>
                    <Icon name="printer" />
                    <div className={ui.select}>
                      <select
                        className={ui.in}
                        value={printer}
                        onChange={(e) => setPrinter(e.target.value)}
                        aria-label="Receipt printer"
                      >
                        {printers.map((p) => (
                          <option key={p.name} value={p.name}>
                            {p.displayName}
                          </option>
                        ))}
                      </select>
                      <Icon name="chevron-down" />
                    </div>
                    <button
                      type="button"
                      className={cx(ui.btn, ui.outline, ui.lg)}
                      onClick={() => void print()}
                      disabled={!printer}
                    >
                      Print receipt
                    </button>
                  </div>
                ) : (
                  <p className={ui.muted}>
                    No printer is installed, so the receipt can&apos;t print.
                  </p>
                )}
                {printMessage && <p role="status">{printMessage}</p>}
                <button
                  type="button"
                  className={cx(ui.btn, ui.primary, s.xl)}
                  onClick={() => {
                    dismissReceipt();
                    focusSearch();
                  }}
                >
                  <Icon name="shopping-cart" />
                  {lines.length ? "Back to the sale" : "New sale"}
                </button>
              </div>
            </>
          ) : (
            <>
              <div>
                <div className={s.dueL}>Total to pay</div>
                <div className={s.dueV}>
                  <small>Rs</small>
                  {money(totals.totalMinor)}
                </div>
                <dl className={s.brk}>
                  <dt>Subtotal</dt>
                  <dd>{money(totals.subtotalMinor)}</dd>
                  <dt>VAT{vatRatePercent ? ` (${vatRatePercent}%)` : ""}</dt>
                  <dd>{money(totals.taxMinor)}</dd>
                </dl>
              </div>
              {rxBox && (
                <button
                  type="button"
                  className={cx(s.cosign, !rxBox.ready && s.cosignTodo)}
                  onClick={openPharmacist}
                >
                  <Icon name={rxBox.ready ? "shield-check" : "pill"} />
                  <div>
                    <b>{rxBox.title}</b>
                    <small>{rxBox.detail}</small>
                  </div>
                  <KeyHint keys="F10" small />
                </button>
              )}
              <div
                className={s.methods}
                role="group"
                aria-label="Payment method"
              >
                {(
                  [
                    ["cash", "banknote", "Cash"],
                    ["card", "credit-card", "Card"],
                    ["split", "split", "Split"],
                  ] as const
                ).map(([id, icon, label]) => (
                  <button
                    key={id}
                    type="button"
                    className={s.m}
                    aria-pressed={method === id}
                    onClick={() => setMethod(id)}
                  >
                    <Icon name={icon} />
                    {label}
                  </button>
                ))}
              </div>
              {method === "cash" && cashBox}
              {method === "card" && (
                <div>
                  <span className={s.fldL}>Card amount</span>
                  <div className={cx(s.moneyIn, s.readOnly)}>
                    <small>Rs</small>
                    <b>{money(totals.totalMinor)}</b>
                  </div>
                  {referenceBox}
                </div>
              )}
              {method === "split" && (
                <>
                  <div>
                    <label className={s.fldL} htmlFor="sell-card">
                      Card amount
                    </label>
                    <div className={s.moneyIn}>
                      <small>Rs</small>
                      <input
                        id="sell-card"
                        inputMode="decimal"
                        autoComplete="off"
                        value={card}
                        onChange={(e) => setCard(moneyInput(e.target.value))}
                        placeholder="0.00"
                      />
                    </div>
                    {card && referenceBox}
                  </div>
                  {cashBox}
                </>
              )}
              <div
                className={cx(
                  s.change,
                  lines.length > 0 && tenderShort && s.short,
                )}
              >
                {lines.length > 0 && tenderShort ? (
                  <>
                    <span>Still to pay</span>
                    <b>Rs {money(totals.totalMinor - tenderedMinor)}</b>
                  </>
                ) : (
                  <>
                    <span>Change to give</span>
                    <b>
                      Rs {money(Math.max(0, tenderedMinor - totals.totalMinor))}
                    </b>
                  </>
                )}
              </div>
              {lastSale && (
                <div className={s.extras}>
                  <button
                    type="button"
                    className={cx(ui.btn, ui.ghost)}
                    onClick={() => {
                      setPrintMessage(null);
                      setSale(lastSale);
                    }}
                  >
                    <Icon name="receipt" />
                    Last receipt
                  </button>
                </div>
              )}
              <div className={s.payActions}>
                <div className={s.payMsg}>
                  {awaiting && (
                    <div role="alert" className={cx(ui.note, ui.noteBad)}>
                      <Icon name="alert-triangle" />
                      <span>
                        This sale may already have gone through. Confirm it in
                        the current sale; don&apos;t take payment again. Clear
                        only to start a different sale.
                      </span>
                    </div>
                  )}
                  {notice && (
                    <p role="status" className={ui.okText}>
                      {notice}
                    </p>
                  )}
                  {error && (
                    <p role="alert" className={ui.badText}>
                      {error}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  className={cx(ui.btn, ui.primary, s.xl)}
                  onClick={() => void complete()}
                  disabled={busy || awaiting || !lines.length || tenderShort}
                >
                  <Icon name="check-circle" />
                  {busy ? "Completing…" : "Complete sale"}
                  <KeyHint keys="F12" small onPrimary />
                </button>
              </div>
            </>
          )}
        </section>
      </div>
      {menu && (
        // Clicking anywhere else closes the open menu.
        <div className={s.menuCatch} onClick={() => setMenu(null)} />
      )}
      {sheetOpen && needsPrescription && (
        <KeyScope layer>
        <PrescriptionSheet
          rxLines={rxLines}
          hasControlled={hasControlled}
          customer={customer}
          prescription={prescription}
          approverId={approverId}
          pin={pin}
          refusal={refusal}
          refusedApproverIds={refusedApproverIds}
          pinRef={pinRef}
          totalText={money(totals.totalMinor)}
          onPrescription={setPrescription}
          onApprover={(id, name) => {
            setApproverId(id);
            setApproverName(name ?? "");
            setPin("");
          }}
          onPin={setPin}
          onCommandSent={onCommandSent}
          onHold={() => void hold()}
          onClose={closeSheet}
          onContinue={continueToPayment}
        />
        </KeyScope>
      )}
    </div>
  );
}

const METHOD_NAMES: Record<string, string> = { cash: "Cash", card: "Card" };

function SalePayment({ method, amount }: { method: string; amount: string }) {
  return (
    <>
      <dt>{METHOD_NAMES[method.toLowerCase()] ?? method}</dt>
      <dd>{money(minor(amount))}</dd>
    </>
  );
}
