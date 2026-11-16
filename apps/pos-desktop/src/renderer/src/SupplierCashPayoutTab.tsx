import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CashPayoutAtCounter, CashPayoutExecuted, DeviceState, LocalShift } from "../../shared/ipc-contract";
import d from "./Dispensing.module.css";
import styles from "./CashShift.module.css";
import { shortName } from "./format";
import { Icon } from "./Icon";
import { invoke } from "./invoke";
import { KeyHint } from "./KeyHint";
import { KeyScope, useKeyBinding } from "./keymap";
import { minor, money } from "./sell-model";
import ui from "./ui.module.css";
import { cx, ErrorLine } from "./useAction";

const PERMISSION_MESSAGE = "Your role can't pay suppliers";

type Phase = "ready" | "processing" | "success";

function amountMinor(amount: string) {
  return minor(amount);
}

function drawerShort(amount: string, expectedCashMinor: number) {
  return amountMinor(amount) > expectedCashMinor;
}

function payoutTitle(row: CashPayoutAtCounter) {
  return row.purchaseOrderNumber
    ? `Supplier payout · ${row.purchaseOrderNumber}`
    : `Supplier payout · ${row.payoutNumber}`;
}

export function SupplierCashPayoutTab({
  device,
  shift,
  online,
  focusPayoutId,
  onFocusConsumed,
  onExecuted,
}: {
  device: DeviceState;
  shift: LocalShift | null;
  online: boolean;
  focusPayoutId?: string | null;
  onFocusConsumed?: () => void;
  onExecuted?: () => void;
}) {
  const [rows, setRows] = useState<CashPayoutAtCounter[] | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sheetPayout, setSheetPayout] = useState<CashPayoutAtCounter | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("ready");
  const [ticked, setTicked] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [done, setDone] = useState<CashPayoutExecuted | null>(null);
  const [printMessage, setPrintMessage] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const expected = shift?.expectedCashMinor ?? null;
  const me = device.staffSession?.staffUserId;
  const shiftOpen = shift?.status === "open";
  const shiftMine = shiftOpen && shift.staffUserId === me;

  const load = useCallback(() => {
    if (!online) return;
    setLoadError(null);
    void invoke(() => window.pos.cashPayoutsReady()).then((result) => {
      if (result.ok) {
        setPermissionDenied(false);
        setRows(result.value);
        return;
      }
      if (result.error.code === "FORBIDDEN" || result.error.code === "PERMISSION_DENIED") {
        setPermissionDenied(true);
        setRows([]);
        return;
      }
      if (result.error.message === PERMISSION_MESSAGE) {
        setPermissionDenied(true);
        setRows([]);
        return;
      }
      setLoadError(result.error.message);
      setRows((current) => current ?? []);
    });
  }, [online]);

  useEffect(() => load(), [load]);
  useEffect(() => {
    if (!focusPayoutId) return;
    setSelectedId(focusPayoutId);
    onFocusConsumed?.();
  }, [focusPayoutId, onFocusConsumed]);

  const selected = useMemo(
    () => (rows ?? []).find((r) => r.cashPayoutId === selectedId) ?? (rows ?? [])[0] ?? null,
    [rows, selectedId],
  );

  const sheetRow = sheetOpen ? sheetPayout : null;

  const expectedDrawerAfter = useMemo(() => {
    if (!done) return null;
    if (done.expectedCashMinorAfter !== null) return done.expectedCashMinorAfter;
    return null;
  }, [done]);

  const short =
    selected && expected !== null ? drawerShort(selected.amount, expected) : false;
  const canPay =
    Boolean(selected) &&
    online &&
    !permissionDenied &&
    shiftMine &&
    !short &&
    phase !== "processing" &&
    phase !== "success";

  function openSheet() {
    if (!selected || short || !shiftMine) return;
    setSheetPayout(selected);
    setSheetOpen(true);
    setPhase("ready");
    setTicked(false);
    setActionError(null);
    setDone(null);
    setPrintMessage(null);
  }

  function closeSheet() {
    if (phase === "processing") return;
    setSheetOpen(false);
    setSheetPayout(null);
    setPhase("ready");
    setTicked(false);
    setActionError(null);
    setDone(null);
    if (phase === "success") load();
  }

  async function payOut() {
    if (!sheetPayout || !ticked || phase === "processing") return;
    setPhase("processing");
    setActionError(null);
    const result = await invoke(() =>
      window.pos.executeCashPayout({ cashPayoutId: sheetPayout.cashPayoutId }),
    );
    if (!result.ok) {
      setPhase("ready");
      setActionError(result.error.message);
      return;
    }
    setDone(result.value);
    setPhase("success");
    onExecuted?.();
  }

  async function printReceipt() {
    if (!done || !sheetPayout) return;
    let printer = "";
    try {
      const printers = await window.pos.listPrinters();
      printer = printers[0]?.name ?? "";
    } catch {
      printer = "";
    }
    if (!printer) {
      setPrintMessage("No receipt printer is set up on this counter.");
      return;
    }
    const result = await window.pos.printSupplierCashPayoutReceipt({
      printerName: printer,
      payoutNumber: done.payoutNumber,
      amountMinor: done.amountMinor,
      supplierPaymentId: done.supplierPaymentId,
      supplierName: done.supplierName ?? sheetPayout.supplierName,
      movementReason: done.movementReason,
      executedAt: new Date().toISOString(),
    });
    setPrintMessage(
      result.ok ? "Receipt sent to the printer." : (result.error ?? "The receipt did not print."),
    );
  }

  useKeyBinding("Ctrl+Enter", () => {
    if (sheetOpen && phase === "ready" && ticked) void payOut();
    else if (!sheetOpen && canPay) openSheet();
  }, { enabled: (sheetOpen && phase === "ready" && ticked) || (!sheetOpen && canPay) });

  if (permissionDenied) {
    return (
      <div className={cx(ui.panel, styles.payoutEmpty)}>
        <span className={cx(ui.kind, styles.emptyIcon)}>
          <Icon name="lock" />
        </span>
        <div>
          <b>{PERMISSION_MESSAGE}</b>
          <small>Ask a manager or owner to pay suppliers, or to grant you supplier payments.</small>
        </div>
      </div>
    );
  }

  if (!online) {
    return (
      <div className={cx(ui.panel, styles.payoutEmpty)}>
        <span className={cx(ui.kind, styles.emptyIcon)}>
          <Icon name="wifi-off" />
        </span>
        <div>
          <b>Supplier payouts need the server</b>
          <small>Paying out is blocked while this counter is offline.</small>
        </div>
      </div>
    );
  }

  if (!shiftOpen) {
    return (
      <div className={cx(ui.panel, styles.payoutEmpty)} role="alert">
        <span className={cx(ui.kind, styles.emptyIcon)}>
          <Icon name="wallet" />
        </span>
        <div>
          <b>Open your shift to pay out</b>
          <small>Count the drawer and open a shift on Cash &amp; shift before supplier payouts can leave the till.</small>
        </div>
      </div>
    );
  }

  if (!shiftMine && shift) {
    return (
      <div className={cx(ui.panel, styles.payoutEmpty)} role="alert">
        <span className={cx(ui.kind, styles.emptyIcon)}>
          <Icon name="wallet" />
        </span>
        <div>
          <b>{shift.staffName}&apos;s shift is open on this till</b>
          <small>
            {shift.staffName.split(" ")[0]} continues it. Paying out needs your own open shift, or they close
            theirs first.
          </small>
        </div>
      </div>
    );
  }

  if (rows === null && !loadError) {
    return <p className={styles.wait}>Loading payouts waiting at this counter…</p>;
  }

  return (
    <div className={styles.payoutBody}>
      <div className={cx(ui.panel, styles.payoutList)}>
        <div className={ui.ph}>
          <h2>Waiting to be paid out</h2>
          <span className={ui.grow} />
          <button type="button" className={cx(ui.btn, ui.ghost, ui.sm)} onClick={load}>
            <Icon name="refresh" />
            Refresh
          </button>
        </div>
        <ErrorLine error={loadError} />
        {!rows?.length ? (
          <p className={styles.wait}>No approved payouts are waiting at this counter.</p>
        ) : (
          <ul className={styles.payoutQueue}>
            {rows.map((row) => {
              const isShort = expected !== null && drawerShort(row.amount, expected);
              const sel = row.cashPayoutId === selected?.cashPayoutId;
              return (
                <li key={row.cashPayoutId}>
                  <button
                    type="button"
                    className={cx(styles.payoutRow, sel && styles.payoutSel, isShort && styles.payoutShort)}
                    aria-current={sel ? "true" : undefined}
                    onClick={() => setSelectedId(row.cashPayoutId)}
                  >
                    <span className={cx(ui.kind, styles.payoutIcon)}>
                      <Icon name="truck" />
                    </span>
                    <span className={styles.payoutMain}>
                      <b>{payoutTitle(row)}</b>
                      <small>
                        {row.supplierName ?? "Supplier"}
                        {row.approvedBy ? ` · approved by ${shortName(row.approvedBy)}` : ""}
                      </small>
                      {isShort && (
                        <span className={cx(ui.pill, ui.warn)}>
                          <Icon name="alert-triangle" />
                          Drawer is short
                        </span>
                      )}
                    </span>
                    <span className={styles.payoutAmt}>Rs {money(amountMinor(row.amount))}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {selected ? (
        <section className={cx(ui.panel, styles.payoutDetail)} aria-label={payoutTitle(selected)}>
          <div className={styles.dh}>
            <span className={cx(ui.kind, styles.payoutKind)}>
              <Icon name="truck" />
            </span>
            <div>
              <div className={ui.eyebrow}>Supplier cash payout</div>
              <h2>{payoutTitle(selected)}</h2>
              <p className={styles.meta}>
                {selected.supplierName ?? "Supplier"} · Rs {money(amountMinor(selected.amount))}
                {selected.reference ? ` · ${selected.reference}` : ""}
              </p>
            </div>
          </div>
          {selected.notes && (
            <p className={styles.wait}>{selected.notes}</p>
          )}
          {short && expected !== null && (
            <ButtonError
              title="The drawer does not hold enough cash for this payout."
              body={`Expected Rs ${money(expected)} in the drawer; this payout is Rs ${money(amountMinor(selected.amount))}.`}
            />
          )}
          <ErrorLine error={actionError} />
          <div className={ui.dfoot}>
            <span className={styles.footText}>
              Cash leaves {device.enrollment?.counterLabel ?? "this till"}&apos;s open shift drawer.
            </span>
            <span className={ui.grow} />
            <button
              type="button"
              className={cx(ui.btn, ui.primary, ui.lg)}
              disabled={!canPay}
              onClick={openSheet}
            >
              <Icon name="banknote" />
              Pay out
              <KeyHint keys="Ctrl+Enter" onPrimary small />
            </button>
          </div>
        </section>
      ) : (
        <section className={cx(ui.panel, styles.payoutDetail)} aria-label="No payout selected">
          <p className={styles.wait}>Select an approved payout to pay out from the drawer.</p>
        </section>
      )}

      {sheetOpen && sheetRow && (
        <KeyScope active>
          <div className={d.scrim} onClick={closeSheet} aria-hidden="true" />
          <aside
            className={d.sheet}
            role="dialog"
            aria-modal="true"
            aria-labelledby="payout-sheet-title"
          >
            <div className={d.head}>
              <span className={d.kind}>
                <Icon name={phase === "success" ? "check-circle" : "banknote"} />
              </span>
              <div>
                <div className={ui.eyebrow}>
                  {phase === "success" ? "supplier_cash_payout.executed" : "Pay supplier from drawer"}
                </div>
                <h2 id="payout-sheet-title">
                  {phase === "success" ? "Payout complete" : payoutTitle(sheetRow)}
                </h2>
                <p>
                  {sheetRow.supplierName ?? "Supplier"} · Rs {money(amountMinor(sheetRow.amount))}
                </p>
              </div>
              <button type="button" className={cx(ui.btn, ui.ghost, ui.sm)} onClick={closeSheet} disabled={phase === "processing"}>
                Close
              </button>
            </div>
            <div className={d.body}>
              {phase === "success" && done ? (
                <>
                  <div className={cx(ui.note, styles.inset)} role="status">
                    <Icon name="check-circle" />
                    <div>
                      <b>{done.alreadyApplied ? "Already paid out" : "Paid out"}</b>
                      <div>
                        Receipt <code>supplier_cash_payout.executed</code>. Payment{" "}
                        <code>{done.supplierPaymentId.slice(0, 8)}</code> ·{" "}
                        <code>amountMinor</code> {done.amountMinor} (Rs {money(done.amountMinor)}). Till cash
                        out: {done.movementReason}.
                      </div>
                    </div>
                  </div>
                  <div className={cx(ui.kvs, styles.inset)}>
                    <div className={ui.kv}>
                      <span>Supplier</span>
                      <b>{done.supplierName ?? sheetRow.supplierName ?? "Supplier"}</b>
                    </div>
                    <div className={ui.kv}>
                      <span>Amount</span>
                      <b>Rs {money(done.amountMinor)}</b>
                    </div>
                    <div className={ui.kv}>
                      <span>Payout</span>
                      <b>{done.payoutNumber}</b>
                    </div>
                    {expectedDrawerAfter !== null && (
                      <div className={ui.kv}>
                        <span>Expected drawer now</span>
                        <b>Rs {money(expectedDrawerAfter)}</b>
                      </div>
                    )}
                  </div>
                  {printMessage && <p className={ui.muted}>{printMessage}</p>}
                </>
              ) : (
                <>
                  <label className={cx(styles.physTick, ticked && styles.physOn)}>
                    <input
                      type="checkbox"
                      checked={ticked}
                      disabled={phase === "processing"}
                      onChange={(e) => setTicked(e.target.checked)}
                    />
                    <Icon name="check" />
                    <span>
                      <b>The cash is in hand and will leave this drawer</b>
                      <small>Local physical confirmation. Then the till signs the payout and pins its approval.</small>
                    </span>
                  </label>
                  <ErrorLine error={actionError} />
                </>
              )}
            </div>
            <form
              ref={formRef}
              className={d.foot}
              onSubmit={(e) => {
                e.preventDefault();
                if (phase === "success") closeSheet();
                else if (ticked) void payOut();
              }}
            >
              {phase !== "success" && (
                <>
                  <button type="button" className={cx(ui.btn, ui.outline)} onClick={closeSheet} disabled={phase === "processing"}>
                    Cancel
                  </button>
                  <span className={ui.grow} />
                  <button
                    type="submit"
                    className={cx(ui.btn, ui.primary, ui.lg)}
                    disabled={!ticked || phase === "processing" || drawerShort(sheetRow.amount, expected ?? 0)}
                  >
                    <Icon name="banknote" />
                    {phase === "processing" ? "Paying out…" : "Pay out"}
                    {ticked && phase !== "processing" && <KeyHint keys="Ctrl+Enter" onPrimary small />}
                  </button>
                </>
              )}
              {phase === "success" && (
                <>
                  <button type="button" className={cx(ui.btn, ui.outline)} onClick={() => void printReceipt()}>
                    Print receipt
                  </button>
                  <span className={ui.grow} />
                  <button type="submit" className={cx(ui.btn, ui.primary, ui.lg)}>
                    Done
                  </button>
                </>
              )}
            </form>
          </aside>
        </KeyScope>
      )}
    </div>
  );
}

function ButtonError({ title, body }: { title: string; body: string }) {
  return (
    <div className={cx(ui.note, ui.noteWarn, styles.inset)} role="alert">
      <Icon name="alert-triangle" />
      <div>
        <b>{title}</b>
        <div>{body}</div>
      </div>
    </div>
  );
}