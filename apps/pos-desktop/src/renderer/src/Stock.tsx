import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type {
  ProductStock,
  StockAttention,
  StockAttentionKind,
  StockBatch,
  StockFilter,
  StockRow,
} from "../../shared/ipc-contract";
import { Icon } from "./Icon";
import { invoke } from "./invoke";
import { KeyHint } from "./KeyHint";
import { clickSubmit, inField, KeyScope, useKeyBinding } from "./keymap";
import { highlight, minor, money, moveSelection } from "./sell-model";
import s from "./Stock.module.css";
import {
  bandText,
  batchStatus,
  expiryLabel,
  expiryWhen,
  movementLine,
  movementWhen,
  packText,
  productName,
  rowNote,
  rs,
  sellFirstBatch,
  unitWord,
  writeOffCheck,
  type Tone,
} from "./stock-model";
import ui from "./ui.module.css";
import { cx } from "./useAction";
import { StockQuarantineSheet } from "./StockQuarantineSheet";
import { WriteOffLimitSheet } from "./WriteOffLimitSheet";
import { P6_EXPIRY_REVIEW_OPENS_QUARANTINE_SHEET } from "./p6-config";

/** "Look up" searches everything; the others list this branch's attention items. "expired" has
 * no tab of its own: Needs attention opens it. */
type Tab = "lookup" | StockAttentionKind;

const FILTERS: { id: StockFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "low", label: "Low stock" },
  { id: "prescription", label: "Prescription" },
  { id: "controlled", label: "Controlled" },
];

const TONE: Record<Tone, string> = {
  ok: ui.ok!,
  warn: ui.warn!,
  bad: ui.bad!,
  info: ui.info!,
  neutral: ui.neutral!,
};

const SEARCH_DELAY_MS = 200;

type Dialog =
  | { mode: "write-off" | "adjust"; batch: StockBatch }
  | { mode: "quarantine" | "release"; batch: StockBatch; fromExpiryReview?: boolean }
  | { mode: "write-off-limit"; batch: StockBatch; qty: number };

/**
 * The write-off and adjust form, over the page. Both post a direct adjustment through the signed
 * command (#95); the server checks the person's permission and the write-off limit.
 */
function AdjustDialog({
  dialog,
  product,
  onClose,
  onDone,
  onOverLimit,
}: {
  dialog: Extract<Dialog, { mode: "write-off" | "adjust" }>;
  product: ProductStock;
  onClose: () => void;
  onDone: (message: string) => void;
  onOverLimit: (batch: StockBatch, qty: number) => void;
}) {
  const { batch, mode } = dialog;
  const writeOff = mode === "write-off";
  const unit = product.product.unit;
  const held = batch.quarantined > 0;
  const [kind, setKind] = useState<string>(
    writeOff ? (batch.expired ? "expired" : "damaged") : "found",
  );
  const [fromQuarantine, setFromQuarantine] = useState(writeOff && held);
  const [qty, setQty] = useState(() =>
    String(writeOff ? (held ? batch.quarantined : batch.available) || 1 : 1),
  );
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const count = Number.parseInt(qty, 10);
  const valid = Number.isInteger(count) && count > 0;
  const correction = kind === "correction_in" || kind === "correction_out";
  const removes = writeOff || kind === "correction_out";
  const check = writeOffCheck(batch, valid ? count : 0, product.writeOffLimit);

  useKeyBinding("Escape", () => onClose());
  useKeyBinding("Ctrl+Enter", () => void clickSubmit(formRef.current));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid) return setError("Enter how many units.");
    if (correction && !reason.trim())
      return setError("Say why the count is being corrected.");
    setBusy(true);
    setError(null);
    const result = await invoke(() =>
      window.pos.adjustStock({
        productId: product.product.productId,
        batchId: batch.batchId,
        kind: correction ? "correction" : (kind as "found" | "damaged" | "expired" | "lost"),
        ...(correction
          ? { direction: kind === "correction_in" ? "in" : "out" }
          : {}),
        qty: count,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
        fromQuarantine: removes && fromQuarantine,
      }),
    );
    setBusy(false);
    if (!result.ok) {
      if (result.error.code === "WRITE_OFF_APPROVAL_REQUIRED") {
        onOverLimit(batch, count);
        return;
      }
      setError(result.error.message);
      return;
    }
    const units = `${result.value.qty} ${unitWord(unit, result.value.qty)}`;
    onDone(
      result.value.movementType === "adjustment_out"
        ? `Wrote off ${units} of ${batch.batchNo}.`
        : `Added ${units} to ${batch.batchNo}.`,
    );
  }

  return (
    <>
      <div className={s.scrim} onClick={onClose} aria-hidden="true" />
      <form
        ref={formRef}
        className={s.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="stock-dialog-title"
        onSubmit={submit}
      >
        <div className={s.dialogHead}>
          <span className={ui.kind}>
            <Icon name={writeOff ? "trash" : "edit"} />
          </span>
          <div>
            <div className={ui.eyebrow}>
              {productName(product.product)} · {batch.batchNo}
            </div>
            <h2 id="stock-dialog-title">
              {writeOff ? "Write off" : "Adjust stock"}
            </h2>
          </div>
        </div>
        <div className={s.dialogBody}>
          <div className={ui.f}>
            <label htmlFor="stock-kind">What happened</label>
            <div className={ui.select}>
              <select
                id="stock-kind"
                className={ui.in}
                value={kind}
                onChange={(e) => setKind(e.target.value)}
                autoFocus
              >
                {writeOff ? (
                  <>
                    <option value="expired">Expired</option>
                    <option value="damaged">Damaged</option>
                    <option value="lost">Lost or missing</option>
                  </>
                ) : (
                  <>
                    <option value="found">Found extra stock</option>
                    <option value="correction_in">Correction: add</option>
                    <option value="correction_out">Correction: remove</option>
                  </>
                )}
              </select>
              <Icon name="chevron-down" />
            </div>
          </div>
          <div className={ui.f}>
            <label htmlFor="stock-qty">
              How many {unitWord(unit)}
              <span>
                {batch.onHand} on hand
                {held ? ` · ${batch.quarantined} held` : ""}
              </span>
            </label>
            <input
              id="stock-qty"
              className={ui.in}
              inputMode="numeric"
              value={qty}
              onChange={(e) => setQty(e.target.value.replace(/\D/g, ""))}
            />
          </div>
          {removes && held && (
            <label className={s.check}>
              <input
                type="checkbox"
                checked={fromQuarantine}
                onChange={(e) => setFromQuarantine(e.target.checked)}
              />
              Take them from the units held in quarantine
            </label>
          )}
          <div className={ui.f}>
            <label htmlFor="stock-reason">
              Note<span>{correction ? "Required" : "Optional"}</span>
            </label>
            <input
              id="stock-reason"
              className={ui.in}
              maxLength={512}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          {removes && (
            <p className={s.limit} data-testid="write-off-limit">
              {limitText(check, batch.costPrice !== null)}
            </p>
          )}
          {error && (
            <p className={ui.badText} role="alert">
              {error}
            </p>
          )}
        </div>
        <div className={ui.dfoot}>
          <span className={ui.grow} />
          <button
            type="button"
            className={cx(ui.btn, ui.ghost, ui.lg)}
            onClick={onClose}
          >
            Cancel
            <KeyHint keys="Escape" />
          </button>
          <button
            type="submit"
            className={cx(ui.btn, ui.primary, ui.lg)}
            disabled={busy || !valid}
          >
            <Icon name={removes ? "trash" : "check"} />
            {busy ? "Posting…" : removes ? "Write off" : "Add to stock"}
            <KeyHint keys="Ctrl+Enter" onPrimary />
          </button>
        </div>
      </form>
    </>
  );
}

/** Whether a write-off needs a manager. `short` leaves out the value, for the footer, whose title has it. */
function limitText(
  check: ReturnType<typeof writeOffCheck>,
  costKnown: boolean,
  short = false,
): string {
  if (check.limitMinor === null)
    return "There is no write-off limit, so no manager approval is needed.";
  const limit = rs(check.limitMinor);
  if (!costKnown || check.valueMinor === null)
    return `Write-offs worth ${limit} or more at cost need a manager's approval.`;
  if (short)
    return check.overLimit
      ? `At or over the ${limit} limit, so a manager has to approve it.`
      : `Under the ${limit} limit, so no manager approval needed.`;
  const value = `${rs(check.valueMinor)} at cost`;
  return check.overLimit
    ? `${value}: at or over the ${limit} limit, so a manager has to approve it.`
    : `${value}: under the ${limit} limit, so no manager approval is needed.`;
}

/** The footer's line about the selected batch, as the mockup's "Write off AUG-6904 · 4 tabs · …". */
function footerText(
  product: ProductStock,
  batch: StockBatch | null,
): { title: string; detail: string } {
  if (!batch)
    return {
      title: "Choose a batch",
      detail: "Pick a batch above to write it off or adjust it.",
    };
  const unit = product.product.unit;
  const status = batchStatus(batch, false);
  if (status.action === "quarantine")
    return {
      title: `${batch.batchNo} should be held`,
      detail: "Quarantine held units at this counter.",
    };
  const qty = batch.quarantined > 0 ? batch.quarantined : batch.available;
  const check = writeOffCheck(batch, qty, product.writeOffLimit);
  const value =
    check.valueMinor === null ? "" : ` · ${rs(check.valueMinor)} at cost`;
  return {
    title: `Write off ${batch.batchNo} · ${qty} ${unitWord(unit, qty)}${value}`,
    detail: limitText(check, batch.costPrice !== null, true),
  };
}

/**
 * Stock (screen=stock): look a product up, see its batches in the order they sell, recent
 * movements and other branches; write off or adjust a batch. Reads only `inventory/stock-by-product`,
 * `inventory/products/:productId/stock` and the write-off policy, which a PIN login may call.
 *
 * Keys (keymap.ts; the page's `<KeyScope>` is in App): F6 search, ↑/↓ move through the results,
 * Ctrl+Enter writes off the selected batch, Esc clears the search or goes back to Sell.
 */
export function Stock({
  branchName,
  active = true,
  online = true,
  onCommandSent,
}: {
  branchName: string;
  /** Shown. The page reads nothing until it is first shown, and rereads its counts each time. */
  active?: boolean;
  online?: boolean;
  onCommandSent?: () => void;
}) {
  const [opened, setOpened] = useState(active);
  useEffect(() => {
    if (active) setOpened(true);
  }, [active]);
  const [tab, setTab] = useState<Tab>("lookup");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<StockFilter>("all");
  const [rows, setRows] = useState<StockRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [listError, setListError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [attention, setAttention] = useState<StockAttention | null>(null);
  const [productId, setProductId] = useState<string | null>(null);
  const [product, setProduct] = useState<ProductStock | null>(null);
  const [productError, setProductError] = useState<string | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expiryReviewPending, setExpiryReviewPending] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const loadAttention = useCallback(() => {
    void invoke(() => window.pos.stockAttention()).then((result) =>
      setAttention(result.ok ? result.value : null),
    );
  }, []);
  useEffect(() => {
    if (active) loadAttention();
  }, [active, loadAttention]);

  // The list: typed search on Look up, or the branch's attention items on the other tabs.
  useEffect(() => {
    if (!opened) return;
    const attentionKind: StockAttentionKind | undefined =
      tab === "lookup" ? undefined : tab;
    const q = query.trim();
    const timer = window.setTimeout(
      () => {
        void invoke(() =>
          window.pos.stockSearch({
            ...(q ? { q } : {}),
            filter,
            ...(attentionKind ? { attention: attentionKind } : {}),
          }),
        ).then((result) => {
          if (!result.ok) {
            setListError(result.error.message);
            setRows([]);
            setTotal(0);
            return;
          }
          setListError(null);
          setRows(result.value.items);
          setTotal(result.value.total);
          setIndex(0);
        });
      },
      q ? SEARCH_DELAY_MS : 0,
    );
    return () => window.clearTimeout(timer);
  }, [opened, tab, query, filter]);

  const loadProduct = useCallback((id: string) => {
    setProductError(null);
    void invoke(() => window.pos.productStock({ productId: id })).then(
      (result) => {
        if (!result.ok) return setProductError(result.error.message);
        setProduct(result.value);
      },
    );
  }, []);

  useEffect(() => {
    if (!productId) return;
    setBatchId(null);
    setProduct((current) =>
      current?.product.productId === productId ? current : null,
    );
    loadProduct(productId);
  }, [productId, loadProduct]);

  // A list with nothing chosen yet shows its first product.
  useEffect(() => {
    if (!productId && rows?.[0]) setProductId(rows[0].productId);
  }, [rows, productId]);

  const sellFirst = useMemo(
    () => (product ? sellFirstBatch(product.batches) : null),
    [product],
  );

  // The batch the footer acts on: the one picked, or the first that needs doing something.
  const selected = useMemo(() => {
    if (!product) return null;
    return (
      product.batches.find((b) => b.batchId === batchId) ??
      product.batches.find(
        (b) => batchStatus(b, false).action === "write-off",
      ) ??
      null
    );
  }, [product, batchId]);

  useEffect(() => {
    if (
      !P6_EXPIRY_REVIEW_OPENS_QUARANTINE_SHEET ||
      !expiryReviewPending ||
      !selected ||
      !product
    )
      return;
    if (selected.nearExpiry || selected.needsExpiryReview) {
      openDialog("quarantine", selected, true);
    }
    setExpiryReviewPending(false);
  }, [expiryReviewPending, selected, product]);

  function choose(i: number) {
    const row = rows?.[i];
    if (!row) return;
    setIndex(i);
    setProductId(row.productId);
    setNotice(null);
  }

  function showTab(next: Tab) {
    setTab(next);
    setFilter("all");
    if (next !== "lookup") setQuery("");
  }

  function openDialog(
    mode: "write-off" | "adjust" | "quarantine" | "release",
    batch: StockBatch | null,
    fromExpiryReview = false,
  ) {
    if (!batch) return;
    setNotice(null);
  if (mode === "quarantine" || mode === "release")
      setDialog({ mode, batch, fromExpiryReview });
    else setDialog({ mode, batch });
  }

  const canWriteOff =
    Boolean(selected) &&
    batchStatus(selected!, false).action !== "quarantine" &&
    selected!.onHand > 0;

  // ---- keys (keymap.ts) ----
  useKeyBinding("F6", () => {
    searchRef.current?.focus();
    searchRef.current?.select();
  });
  useKeyBinding(
    ["ArrowUp", "ArrowDown"],
    (event) => {
      if (inField(event.target) && event.target !== searchRef.current)
        return false;
      if (!rows?.length) return false;
      choose(moveSelection(index, event.key === "ArrowUp" ? -1 : 1, rows.length));
    },
    { inFields: true, repeat: true },
  );
  useKeyBinding("Ctrl+Enter", () => openDialog("write-off", selected), {
    enabled: canWriteOff && !dialog,
  });
  useKeyBinding("Escape", () => {
    if (query) return void setQuery("");
    if (tab !== "lookup") return void showTab("lookup");
    return false;
  });

  const units = (n: number) => unitWord(product?.product.unit ?? null, n);
  const price = sellFirst ?? product?.batches[0] ?? null;
  const reservedFor = product?.reservations[0]?.label;
  const footer = product ? footerText(product, selected) : null;
  const expiringLabel = attention
    ? `${attention.expiringBatches} batch${attention.expiringBatches === 1 ? "" : "es"} expire within ${attention.expiryWarningDays} days`
    : "";

  return (
    <section className={s.stock} aria-label="Stock">
      <div className={ui.pageH}>
        <div>
          <h1>Stock</h1>
          <p>
            Look up any product, quarantine or release a batch, adjust and write
            off. Large write-offs need a manager.
          </p>
        </div>
        <span className={ui.grow} />
        <div className={cx(ui.seg, s.tabs)} role="group" aria-label="Lists">
          <button
            type="button"
            aria-pressed={tab === "lookup"}
            onClick={() => showTab("lookup")}
          >
            Look up
          </button>
          <button
            type="button"
            aria-pressed={tab === "near_expiry"}
            onClick={() => showTab("near_expiry")}
          >
            Expiring soon
            {attention ? <i>{attention.expiringBatches}</i> : null}
          </button>
          <button
            type="button"
            aria-pressed={tab === "quarantined"}
            onClick={() => showTab("quarantined")}
          >
            Quarantined
            {attention ? <i>{attention.quarantinedProducts}</i> : null}
          </button>
        </div>
      </div>

      <div className={s.body}>
        <div className={cx(ui.panel, s.find)}>
          <div className={s.findTop}>
            <div className={s.search}>
              <Icon name="barcode-scan" />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  if (tab !== "lookup") setTab("lookup");
                }}
                placeholder="Scan or type a name"
                aria-label="Find a product"
                autoComplete="off"
              />
              <KeyHint keys="F6" />
            </div>
            <div className={s.chips} role="group" aria-label="Show">
              {FILTERS.map((f) => (
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
          <div className={s.resHead}>
            <span>
              {total} match{total === 1 ? "" : "es"}
            </span>
            <span className={s.hint}>Available · nearest expiry</span>
          </div>
          <ul className={s.results} aria-label="Products">
            {listError && <li className={s.empty}>{listError}</li>}
            {rows?.length === 0 && !listError && (
              <li className={s.empty}>
                {tab === "lookup"
                  ? "No product in this branch's range matches."
                  : "Nothing here needs attention."}
              </li>
            )}
            {rows?.map((row, i) => {
              const note = rowNote(row);
              return (
                <li key={row.productId}>
                  <button
                    type="button"
                    className={cx(
                      s.res,
                      row.productId === productId && s.sel,
                    )}
                    aria-current={row.productId === productId}
                    onClick={() => choose(i)}
                  >
                    <div className={s.resMain}>
                      <div className={s.resName}>
                        <Highlighted name={productName(row)} query={query} />
                        {row.requiresPrescription && (
                          <span className={s.rx}>Rx</span>
                        )}
                      </div>
                      <div className={s.resMeta}>
                        {[
                          packText(row),
                          `${row.batchCount} batch${row.batchCount === 1 ? "" : "es"}`,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    </div>
                    <div className={s.resSide}>
                      <div className={s.qty}>
                        {row.available}{" "}
                        <small>{unitWord(row.unit, row.available)}</small>
                      </div>
                      {note.text && (
                        <div className={cx(s.note, s[`note_${note.tone}`])}>
                          {note.text}
                        </div>
                      )}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className={s.quick}>
            <div className={s.subH}>
              Needs attention <span>{branchName}</span>
            </div>
            <div className={s.att} aria-label="Needs attention">
              {attention === null ? (
                <div className={s.empty}>Checking this branch…</div>
              ) : (
                <>
                  <AttentionRow
                    icon="calendar"
                    tone="rose"
                    title={expiringLabel}
                    detail="Review and quarantine before they're sold"
                    onClick={() => {
                      if (P6_EXPIRY_REVIEW_OPENS_QUARANTINE_SHEET)
                        setExpiryReviewPending(true);
                      showTab("near_expiry");
                    }}
                  />
                  {attention.expiredBatches > 0 && (
                    <AttentionRow
                      icon="alert-triangle"
                      tone="rose"
                      title={`${attention.expiredBatches} expired batch${attention.expiredBatches === 1 ? "" : "es"} not yet held`}
                      detail="Expired stock can't be sold; quarantine or write it off"
                      onClick={() => showTab("expired")}
                    />
                  )}
                  <AttentionRow
                    icon="alert-triangle"
                    tone="amber"
                    title={`${attention.quarantinedUnits} ${attention.quarantinedUnits === 1 ? "unit" : "units"} in quarantine`}
                    detail={`Across ${attention.quarantinedProducts} product${attention.quarantinedProducts === 1 ? "" : "s"} · release, write off or return to supplier`}
                    onClick={() => showTab("quarantined")}
                  />
                  <AttentionRow
                    icon="package"
                    tone="blue"
                    title={`${attention.lowStockProducts} product${attention.lowStockProducts === 1 ? "" : "s"} below reorder level`}
                    detail="Purchase orders are raised on the web"
                    onClick={() => {
                      showTab("lookup");
                      setFilter("low");
                    }}
                  />
                </>
              )}
            </div>
          </div>
        </div>

        <div className={cx(ui.panel, s.detail)}>
          {!product ? (
            <div className={s.detailEmpty}>
              {productError ? (
                <p className={ui.badText} role="alert">
                  {productError}
                </p>
              ) : (
                <>
                  <Icon name="package" />
                  <b>{productId ? "Loading…" : "Look up a product"}</b>
                  {!productId &&
                    "Scan a barcode or type a name to see its batches."}
                </>
              )}
            </div>
          ) : (
            <>
              <div className={s.dh}>
                <span className={ui.kind}>
                  <Icon name="package" />
                </span>
                <div className={s.dhMain}>
                  <div className={ui.eyebrow}>Product</div>
                  <h2>{productName(product.product)}</h2>
                  <div className={s.meta}>
                    {product.product.genericName && (
                      <span>
                        <Icon name="pill" />
                        {product.product.genericName}
                      </span>
                    )}
                    {packText(product.product) && (
                      <span>
                        <Icon name="box" />
                        {packText(product.product)}
                      </span>
                    )}
                    {price && (
                      <span>
                        <Icon name="tag" />
                        Rs {money(minor(price.sellingPrice))} /{" "}
                        {unitWord(product.product.unit, 1)}
                      </span>
                    )}
                  </div>
                </div>
                <div className={s.dhRight}>
                  {product.product.isControlled ? (
                    <span className={cx(ui.pill, s.rxPill)}>Controlled</span>
                  ) : product.product.requiresPrescription ? (
                    <span className={cx(ui.pill, s.rxPill)}>
                      Prescription only
                    </span>
                  ) : null}
                </div>
              </div>

              <div className={cx(ui.tiles, s.tiles)}>
                <div className={cx(ui.tile, s.tileMain)}>
                  <small>Available</small>
                  <b>
                    {product.totals.available}
                    <em>{units(product.totals.available)}</em>
                  </b>
                  <span>Can be sold now</span>
                </div>
                <div className={ui.tile}>
                  <small>On hand</small>
                  <b>
                    {product.totals.onHand}
                    <em>{units(product.totals.onHand)}</em>
                  </b>
                  <span>
                    Across {product.batches.length} batch
                    {product.batches.length === 1 ? "" : "es"}
                  </span>
                </div>
                <div className={ui.tile}>
                  <small>Reserved</small>
                  <b>
                    {product.totals.reserved}
                    <em>{units(product.totals.reserved)}</em>
                  </b>
                  <span>
                    {product.reservations.length > 1
                      ? `${product.reservations.length} transfers`
                      : reservedFor
                        ? `Transfer ${reservedFor}`
                        : "Nothing promised"}
                  </span>
                </div>
                <div className={ui.tile}>
                  <small>Quarantined</small>
                  <b>
                    {product.totals.quarantined}
                    <em>{units(product.totals.quarantined)}</em>
                  </b>
                  <span>
                    {product.totals.quarantined > 0
                      ? "Held · not for sale"
                      : "Nothing held"}
                  </span>
                </div>
              </div>

              <div className={s.secH}>
                Batches <span>Oldest expiry first · sold in this order</span>
              </div>
              <div className={s.table} role="table" aria-label="Batches">
                <div className={cx(s.tr, s.th)} role="row">
                  <span role="columnheader">Batch</span>
                  <span role="columnheader">Expiry</span>
                  <span role="columnheader" className={s.c}>
                    On hand
                  </span>
                  <span role="columnheader" className={s.c}>
                    Reserved
                  </span>
                  <span role="columnheader" className={s.c}>
                    Quarantined
                  </span>
                  <span role="columnheader">Status</span>
                  <span role="columnheader" />
                </div>
                {product.batches.length === 0 && (
                  <div className={s.empty} role="row">
                    No stock of this product at this branch.
                  </div>
                )}
                {product.batches.map((b) => {
                  const status = batchStatus(
                    b,
                    b.batchId === sellFirst?.batchId,
                  );
                  const exp = b.expired ? s.exBad : b.nearExpiry ? s.exWarn : "";
                  return (
                    <div
                      key={b.batchId}
                      role="row"
                      className={cx(
                        s.tr,
                        b.batchId === selected?.batchId && s.trSel,
                      )}
                      onClick={() => setBatchId(b.batchId)}
                      aria-selected={b.batchId === selected?.batchId}
                    >
                      <span role="cell" className={ui.mono}>
                        {b.batchNo}
                      </span>
                      <span role="cell" className={cx(s.ex, exp)}>
                        <b>{expiryLabel(b.expiryDate, b.nearExpiry)}</b>
                        <small>{expiryWhen(b.daysToExpiry)}</small>
                      </span>
                      <span role="cell" className={s.num}>
                        {b.onHand}
                      </span>
                      <span role="cell" className={cx(s.num, !b.reserved && s.dim)}>
                        {b.reserved || "—"}
                      </span>
                      <span
                        role="cell"
                        className={cx(s.num, !b.quarantined && s.dim)}
                      >
                        {b.quarantined || "—"}
                      </span>
                      <span role="cell">
                        <span className={cx(ui.pill, TONE[status.tone])}>
                          {status.label}
                        </span>
                      </span>
                      <span role="cell" className={s.act}>
                        {status.action === "write-off" && (
                          <button
                            type="button"
                            className={cx(ui.btn, ui.sm, ui.outline)}
                            onClick={(e) => {
                              e.stopPropagation();
                              setBatchId(b.batchId);
                              openDialog("write-off", b);
                            }}
                          >
                            Write off
                          </button>
                        )}
                        {status.action === "quarantine" && (
                          <button
                            type="button"
                            className={cx(ui.btn, ui.sm, ui.outline)}
                            onClick={(e) => {
                              e.stopPropagation();
                              setBatchId(b.batchId);
                              openDialog("quarantine", b);
                            }}
                          >
                            Quarantine
                          </button>
                        )}
                        {status.action === "adjust" && (
                          <button
                            type="button"
                            className={cx(ui.btn, ui.sm, ui.ghost)}
                            onClick={(e) => {
                              e.stopPropagation();
                              setBatchId(b.batchId);
                              openDialog("adjust", b);
                            }}
                          >
                            Adjust
                          </button>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>

              <div className={s.cards}>
                <div className={s.card}>
                  <div className={s.subH}>
                    Other branches <span>Availability</span>
                  </div>
                  {!product.otherBranches.allowed ? (
                    <div className={s.footN}>
                      Your role doesn&apos;t show other branches&apos; stock.
                    </div>
                  ) : product.otherBranches.branches.length === 0 ? (
                    <div className={s.footN}>This is the only branch.</div>
                  ) : (
                    product.otherBranches.branches.map((b) => {
                      const band = bandText(b.band);
                      return (
                        <div
                          key={b.branchId}
                          className={cx(s.kv, s[`kv_${band.tone}`])}
                        >
                          <span className={s.dot} />
                          {b.name}
                          <b>{band.text}</b>
                        </div>
                      );
                    })
                  )}
                  <div className={s.footN}>
                    Transfers are requested and approved on the web.
                  </div>
                </div>
                <div className={s.card}>
                  <div className={s.subH}>
                    Recent movements <span>All batches</span>
                  </div>
                  {product.movements.length === 0 && (
                    <div className={s.footN}>No movements yet.</div>
                  )}
                  {product.movements.slice(0, 5).map((m) => {
                    const line = movementLine(m);
                    return (
                      <div key={m.id} className={s.mv}>
                        <span className={s.mvT}>
                          {movementWhen(m.occurredAt, new Date())}
                        </span>
                        <span className={s.mvD}>
                          {line.what}
                          {line.batchNo && (
                            <>
                              {" · "}
                              <b>{line.batchNo}</b>
                            </>
                          )}
                          {line.who ? ` · ${line.who}` : ""}
                        </span>
                        <span className={cx(s.mvQ, s[`mv_${line.tone}`])}>
                          {line.qty}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className={cx(ui.dfoot, s.foot)}>
                <div className={s.lim}>
                  {notice ? (
                    <b className={s.done} role="status">
                      {notice}
                    </b>
                  ) : (
                    footer && (
                      <>
                        <b>{footer.title}</b>
                        {footer.detail}
                      </>
                    )
                  )}
                </div>
                <span className={ui.grow} />
                {selected &&
                  selected.quarantined > 0 &&
                  !selected.expired && (
                    <button
                      type="button"
                      className={cx(ui.btn, ui.ghost, ui.lg)}
                      onClick={() => openDialog("release", selected)}
                    >
                      <Icon name="refresh" />
                      Release
                    </button>
                  )}
                {selected && batchStatus(selected, false).action === "quarantine" && (
                  <button
                    type="button"
                    className={cx(ui.btn, ui.primary, ui.lg)}
                    onClick={() => openDialog("quarantine", selected)}
                  >
                    <Icon name="alert-triangle" />
                    Quarantine
                  </button>
                )}
                <button
                  type="button"
                  className={cx(ui.btn, ui.outline, ui.lg)}
                  disabled={!selected}
                  onClick={() => openDialog("adjust", selected)}
                >
                  <Icon name="edit" />
                  Adjust stock
                </button>
                <button
                  type="button"
                  className={cx(ui.btn, ui.primary, ui.lg)}
                  disabled={!canWriteOff}
                  onClick={() => openDialog("write-off", selected)}
                >
                  <Icon name="trash" />
                  Write off
                  <KeyHint keys="Ctrl+Enter" onPrimary />
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {dialog && product && (dialog.mode === "write-off" || dialog.mode === "adjust") && (
        <KeyScope layer>
          <AdjustDialog
            dialog={dialog}
            product={product}
            onClose={() => setDialog(null)}
            onOverLimit={(batch, qty) => setDialog({ mode: "write-off-limit", batch, qty })}
            onDone={(message) => {
              setDialog(null);
              setNotice(message);
              onCommandSent?.();
              loadProduct(product.product.productId);
              loadAttention();
            }}
          />
        </KeyScope>
      )}
      {dialog && product && (dialog.mode === "quarantine" || dialog.mode === "release") && (
        <StockQuarantineSheet
          mode={dialog.mode}
          product={product}
          batch={dialog.batch}
          online={online}
          fromExpiryReview={dialog.fromExpiryReview}
          onClose={() => setDialog(null)}
          onCommandSent={onCommandSent}
          onDone={(message) => {
            setDialog(null);
            setNotice(message);
            loadProduct(product.product.productId);
            loadAttention();
          }}
        />
      )}
      {dialog && product && dialog.mode === "write-off-limit" && (
        <WriteOffLimitSheet
          product={product}
          batch={dialog.batch}
          qty={dialog.qty}
          onClose={() => setDialog(null)}
        />
      )}
    </section>
  );
}

function Highlighted({ name, query }: { name: string; query: string }) {
  const part = highlight(name, query);
  return (
    <span>
      {part.before}
      {part.hit && <mark>{part.hit}</mark>}
      {part.after}
    </span>
  );
}

function AttentionRow({
  icon,
  tone,
  title,
  detail,
  onClick,
}: {
  icon: "calendar" | "alert-triangle" | "package";
  tone: "rose" | "amber" | "blue";
  title: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className={s.attR} onClick={onClick}>
      <span className={cx(s.qi, s[`qi_${tone}`])}>
        <Icon name={icon} />
      </span>
      <span className={s.attText}>
        <b>{title}</b>
        <small>{detail}</small>
      </span>
      <span className={s.go}>
        <Icon name="chevron-right" />
      </span>
    </button>
  );
}
