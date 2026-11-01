import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import type {
  CatalogProduct,
  CheckoutDraftView,
  CompletedSale,
  CustomerView,
  HeldCart,
  PrescriptionView,
  Printer,
} from "../../shared/ipc-contract";
import styles from "./App.module.css";
import { DispensingPanel } from "./Dispensing";

type Line = { product: CatalogProduct; qty: number };

const minor = (amount: string) => Math.round(Number(amount) * 100);
const display = (value: number) => (value / 100).toFixed(2);

function matches(product: CatalogProduct, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  return (
    product.name.toLowerCase().includes(q) ||
    (product.sku ?? "").toLowerCase() === q ||
    (product.barcode ?? "") === query.trim()
  );
}

function Receipt({
  sale,
  onDone,
}: {
  sale: CompletedSale;
  onDone: () => void;
}) {
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [printer, setPrinter] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    void window.pos.listPrinters().then((list) => {
      setPrinters(list);
      setPrinter(list[0]?.name ?? "");
    });
  }, []);
  async function print() {
    const result = await window.pos.printSaleReceipt({
      saleId: sale.saleId,
      printerName: printer,
    });
    setMessage(
      result.ok
        ? "Receipt sent to the printer."
        : (result.error ?? "The receipt did not print."),
    );
  }
  return (
    <div className={styles.form}>
      <h2 className={styles.panelTitle}>Sale complete — {sale.invoiceNo}</h2>
      <dl className={styles.facts}>
        <dt>Total</dt>
        <dd>{sale.grandTotal}</dd>
        <dt>Paid</dt>
        <dd>{sale.amountPaid}</dd>
        <dt>Change</dt>
        <dd>{sale.changeDue}</dd>
      </dl>
      <div className={styles.actions}>
        {printers.length > 0 && (
          <>
            <select
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
            <button
              type="button"
              className="pc-btn-outline"
              onClick={() => void print()}
              disabled={!printer}
            >
              Print receipt
            </button>
          </>
        )}
        <button type="button" className="pc-btn-primary-sm" onClick={onDone}>
          New sale
        </button>
      </div>
      {message && <p role="status">{message}</p>}
    </div>
  );
}

function PendingCheckouts({
  onResolved,
}: {
  onResolved: (sale: CompletedSale) => void;
}) {
  const [drafts, setDrafts] = useState<CheckoutDraftView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pins, setPins] = useState<Record<string, string>>({});
  const load = useCallback(() => {
    void window.pos.pendingCheckouts().then(setDrafts);
  }, []);
  useEffect(load, [load]);
  if (!drafts.length) return null;
  async function confirm(draft: CheckoutDraftView) {
    setError(null);
    const pin = pins[draft.draftId];
    const result = await window.pos.retryCheckout({
      draftId: draft.draftId,
      ...(draft.coSignerId && pin
        ? { coSign: { approverUserId: draft.coSignerId, pin } }
        : {}),
    });
    setPins((current) => ({ ...current, [draft.draftId]: "" }));
    if (result.ok) onResolved(result.value);
    else setError(result.error.message);
    load();
  }
  return (
    <div className={styles.form} role="alert">
      <p className={styles.resultFailed}>
        {drafts.length === 1 ? "A sale was" : `${drafts.length} sales were`}{" "}
        sent but not confirmed. Confirm before taking payment again — confirming
        never charges twice.
      </p>
      <ul className={styles.counterList}>
        {drafts.map((d) => (
          <li key={d.draftId} className={styles.counterOption}>
            <span>
              {d.lineCount} item{d.lineCount === 1 ? "" : "s"}, about{" "}
              {d.estimatedTotal}, {new Date(d.createdAt).toLocaleTimeString()}
            </span>
            {d.coSignerId && (
              <input
                type="password"
                autoComplete="off"
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
              className="pc-btn-outline"
              onClick={() => void confirm(d)}
            >
              Confirm with server
            </button>
          </li>
        ))}
      </ul>
      {error && <p className={styles.resultFailed}>{error}</p>}
    </div>
  );
}

/** Online checkout at this counter. Prices and totals are the server's; this only collects choices. */
export function Checkout() {
  const [catalog, setCatalog] = useState<CatalogProduct[] | null>(null);
  const [query, setQuery] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [cash, setCash] = useState("");
  const [card, setCard] = useState("");
  const [cardReference, setCardReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sale, setSale] = useState<CompletedSale | null>(null);
  const [holds, setHolds] = useState<HeldCart[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [customer, setCustomer] = useState<CustomerView | null>(null);
  const [prescription, setPrescription] = useState<PrescriptionView | null>(
    null,
  );
  const [approverId, setApproverId] = useState("");
  const [pin, setPin] = useState("");

  const needsPrescription = lines.some((l) => l.product.needsPharmacist);
  const hasControlled = lines.some((l) => l.product.isControlled);
  const dispensing = {
    ...(customer ? { customerId: customer.customerId } : {}),
    ...(prescription && needsPrescription
      ? { prescriptionId: prescription.prescriptionId }
      : {}),
  };

  function resetSale() {
    setLines([]);
    setCustomer(null);
    setPrescription(null);
    setApproverId("");
    setPin("");
  }

  const loadHolds = useCallback(() => {
    void window.pos
      .listHolds()
      .then((result) => setHolds(result.ok ? result.value : []));
  }, []);
  useEffect(loadHolds, [loadHolds]);

  async function hold() {
    setError(null);
    const result = await window.pos.holdCart({
      lines: lines.map((l) => ({ productId: l.product.productId, qty: l.qty })),
      dispensing,
    });
    if (result.ok) {
      resetSale();
      setNotice(`Held as ${result.value.holdRef}.`);
      loadHolds();
    } else setError(result.error.message);
  }

  async function recall(holdId: string) {
    setError(null);
    const result = await window.pos.recallHold({ holdId });
    loadHolds();
    if (!result.ok) return setError(result.error.message);
    const byId = new Map((catalog ?? []).map((p) => [p.productId, p]));
    const held = result.value;
    setCustomer(held.customer);
    setPrescription(held.prescription);
    const restored = held.lines.flatMap((l) => {
      const product = byId.get(l.productId);
      return product
        ? [{ product, qty: Math.min(l.qty, product.available) }]
        : [];
    });
    setLines(restored);
    if (restored.length < held.lines.length)
      setNotice("Some held items are no longer available and were left out.");
  }

  const refresh = useCallback(() => {
    setError(null);
    void window.pos.catalog().then((result) => {
      if (result.ok) setCatalog(result.value);
      else setError(result.error.message);
    });
  }, []);
  useEffect(refresh, [refresh]);

  const results = useMemo(
    () => (catalog ?? []).filter((p) => matches(p, query)).slice(0, 20),
    [catalog, query],
  );
  const estimate = lines.reduce(
    (sum, l) => sum + minor(l.product.unitPrice) * l.qty,
    0,
  );

  function add(product: CatalogProduct) {
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
    setQuery("");
  }

  function setQty(productId: string, qty: number) {
    setLines((current) =>
      qty <= 0
        ? current.filter((l) => l.product.productId !== productId)
        : current.map((l) =>
            l.product.productId === productId ? { ...l, qty } : l,
          ),
    );
  }

  function onSearch(event: FormEvent) {
    event.preventDefault();
    // A scanner types the barcode and Enter: add the exact match straight away.
    const exact = (catalog ?? []).find(
      (p) => p.barcode && p.barcode === query.trim(),
    );
    if (exact) add(exact);
    else if (results.length === 1) add(results[0]!);
  }

  async function complete() {
    if (hasControlled && approverId && !pin) {
      setError("Ask the pharmacist to enter their PIN.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await window.pos.submitCheckout({
        lines: lines.map((l) => ({
          productId: l.product.productId,
          qty: l.qty,
        })),
        tender: {
          ...(cash ? { cashAmount: cash } : {}),
          ...(card ? { cardAmount: card, cardReference } : {}),
        },
        dispensing,
        ...(hasControlled && approverId
          ? { coSign: { approverUserId: approverId, pin } }
          : {}),
      });
      // The PIN is good for one attempt; never leave it sitting in the form.
      setPin("");
      if (result.ok) {
        setSale(result.value);
        resetSale();
        setCash("");
        setCard("");
        setCardReference("");
      } else setError(result.error.message);
    } finally {
      setBusy(false);
    }
  }

  if (sale)
    return (
      <section
        className={`${styles.panel} ${styles.wide}`}
        aria-label="Checkout"
      >
        <Receipt
          sale={sale}
          onDone={() => {
            setSale(null);
            refresh();
          }}
        />
      </section>
    );

  return (
    <section className={`${styles.panel} ${styles.wide}`} aria-label="Checkout">
      <h2 className={styles.panelTitle}>Checkout</h2>
      <PendingCheckouts onResolved={setSale} />
      <form className={styles.form} onSubmit={onSearch}>
        <label className={styles.field}>
          <span>Scan or search</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Barcode, SKU or name"
            autoFocus
          />
        </label>
      </form>
      {catalog === null && !error && (
        <p className="pc-muted">Loading products…</p>
      )}
      {results.length > 0 && (
        <ul className={styles.counterList}>
          {results.map((p) => (
            <li key={p.productId}>
              <button
                type="button"
                className={styles.counterOption}
                onClick={() => add(p)}
                disabled={p.available <= 0}
              >
                <span>
                  {p.name}
                  {p.strength ? ` ${p.strength}` : ""}
                </span>
                <span className="pc-muted">
                  {p.unitPrice} · {p.available} available
                  {p.isControlled
                    ? " · controlled"
                    : p.needsPharmacist
                      ? " · prescription"
                      : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {lines.length > 0 && (
        <table className={styles.checks}>
          <tbody>
            {lines.map((l) => (
              <tr key={l.product.productId}>
                <td>{l.product.name}</td>
                <td>
                  <input
                    type="number"
                    min={0}
                    max={l.product.available}
                    value={l.qty}
                    onChange={(e) =>
                      setQty(l.product.productId, Number(e.target.value))
                    }
                    aria-label={`Quantity of ${l.product.name}`}
                  />
                </td>
                <td>{display(minor(l.product.unitPrice) * l.qty)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {lines.length > 0 && (
        <DispensingPanel
          needsPrescription={needsPrescription}
          hasControlled={hasControlled}
          customer={customer}
          prescription={prescription}
          approverId={approverId}
          pin={pin}
          onCustomer={setCustomer}
          onPrescription={setPrescription}
          onApprover={(id) => {
            setApproverId(id);
            setPin("");
          }}
          onPin={setPin}
        />
      )}
      <p>
        Before tax: <strong>{display(estimate)}</strong>{" "}
        <span className="pc-muted">(tax is added at checkout)</span>
      </p>
      <div className={styles.actions}>
        <label className={styles.field}>
          <span>Cash received</span>
          <input
            inputMode="decimal"
            value={cash}
            onChange={(e) => setCash(e.target.value.replace(/[^\d.]/g, ""))}
          />
        </label>
        <label className={styles.field}>
          <span>Card amount</span>
          <input
            inputMode="decimal"
            value={card}
            onChange={(e) => setCard(e.target.value.replace(/[^\d.]/g, ""))}
          />
        </label>
        {card && (
          <label className={styles.field}>
            <span>Card approval reference</span>
            <input
              value={cardReference}
              onChange={(e) => setCardReference(e.target.value)}
            />
          </label>
        )}
      </div>
      <div className={styles.actions}>
        <button
          type="button"
          className="pc-btn-primary-sm"
          onClick={() => void complete()}
          disabled={busy || !lines.length}
        >
          {busy ? "Completing…" : "Complete sale"}
        </button>
        <button
          type="button"
          className="pc-btn-outline"
          onClick={() => void hold()}
          disabled={busy || !lines.length}
        >
          Hold
        </button>
        <button
          type="button"
          className="pc-btn-outline"
          onClick={resetSale}
          disabled={busy || !lines.length}
        >
          Clear
        </button>
        <button
          type="button"
          className="pc-btn-outline"
          onClick={refresh}
          disabled={busy}
        >
          Refresh products
        </button>
      </div>
      {notice && <p role="status">{notice}</p>}
      {holds.length > 0 && (
        <div className={styles.form}>
          <h3 className={styles.panelTitle}>Held carts</h3>
          <ul className={styles.counterList}>
            {holds.map((h) => (
              <li key={h.holdId} className={styles.counterOption}>
                <span>
                  {h.holdRef}
                  {h.label ? ` · ${h.label}` : ""} · {h.itemCount} items ·{" "}
                  {h.total} · {h.heldBy}
                </span>
                <button
                  type="button"
                  className="pc-btn-outline"
                  onClick={() => void recall(h.holdId)}
                  disabled={busy || lines.length > 0}
                >
                  Recall
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && (
        <p role="alert" className={styles.resultFailed}>
          {error}
        </p>
      )}
    </section>
  );
}
