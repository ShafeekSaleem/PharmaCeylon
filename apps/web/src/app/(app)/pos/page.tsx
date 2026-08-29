"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Modal, ModalButton, ModalFooter } from "@/components/ui";
import { RolePageGuard } from "@/components/role-access";
import { POS_ROLES } from "@/lib/role-access";
import { useAuth } from "@/lib/use-auth";
import { useRoleAccess } from "@/lib/use-role-access";
import { PosActionBar } from "./components/pos-action-bar";
import { PosAlertsPanel } from "./components/pos-alerts-panel";
import { PosBatchModal } from "./components/pos-batch-modal";
import { PosCartPanel } from "./components/pos-cart-panel";
import { PosCustomerModal } from "./components/pos-customer-modal";
import { PosHoldsModal } from "./components/pos-holds-modal";
import { PosLookupModal, type LookupMode } from "./components/pos-lookup-modal";
import { PosPharmacistPinModal } from "./components/pos-pharmacist-pin-modal";
import { PosPrescriptionModal } from "./components/pos-prescription-modal";
import { PosQuickActions } from "./components/pos-quick-actions";
import { PosQuickAdd } from "./components/pos-quick-add";
import { PosReceiptModal, type ReceiptPreferences } from "./components/pos-receipt-modal";
import { PosReturnsPanel } from "./components/pos-returns-panel";
import { PosSearchBar } from "./components/pos-search-bar";
import { PosSetPinModal } from "./components/pos-set-pin-modal";
import { PosShortcutsModal } from "./components/pos-shortcuts-modal";
import { PosSummaryPanel, type TenderMode } from "./components/pos-summary-panel";
import { PosToasts } from "./components/pos-toasts";
import { PAYMENT_METHODS, type QuickAddTab } from "./constants";
import { usePosAlerts } from "./hooks/use-pos-alerts";
import { usePosCart } from "./hooks/use-pos-cart";
import { usePosCatalog } from "./hooks/use-pos-catalog";
import { usePosHolds } from "./hooks/use-pos-holds";
import { usePosShortcuts } from "./hooks/use-pos-shortcuts";
import { usePosToasts } from "./hooks/use-pos-toasts";
import { useScanBeep } from "./hooks/use-scan-beep";
import { fetchTenantSettings } from "../settings/lib/tenant-settings";
import { apiJson } from "@/lib/auth-client";
import { checkout, createHold, findSaleByInvoice, getCustomer, getPrescription } from "./services/pos-api";
import type {
  CartLine,
  Customer,
  HoldReason,
  PaymentMethod,
  PharmacistApproval,
  PosAlertActionKind,
  PosMode,
  PosProduct,
  Prescription,
  RecentSale,
  ResolvedCartLine,
  SaleReceipt,
  TenderLine,
} from "./types";
import { formatMoney, makeLineKey, newIdempotencyKey } from "./utils";
import css from "./pos.module.css";

const RX_ROLES = ["owner", "manager", "pharmacist"] as const;

const EMPTY_SPLIT: Record<PaymentMethod, string> = {
  cash: "",
  card: "",
  mobile_wallet: "",
};

type Confirm = {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
};

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "PC";
}

/** `INV-2507` — the real number is allocated by the API when the sale posts. */
function draftInvoiceLabel(): string {
  const now = new Date();
  const period = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}`;
  return `INV-${period}`;
}

function PosWorkspace() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const deepProductId = searchParams.get("productId");
  const deepPanel = searchParams.get("panel");
  const deepMode = searchParams.get("mode");
  const deepFocus = searchParams.get("focus");
  const deepHoldId = searchParams.get("holdId");
  const deepInvoice = searchParams.get("invoice");

  const { user } = useAuth();
  const { canAccess } = useRoleAccess();
  const toasts = usePosToasts();
  const { beep, beepEnabled, toggleBeep } = useScanBeep();

  const {
    products,
    departments,
    productsById,
    vatRatePercent,
    recentSales,
    loading,
    error,
    hasBranch,
    reload,
  } = usePosCatalog();
  const cart = usePosCart(productsById, vatRatePercent);
  const holds = usePosHolds();

  const [mode, setMode] = useState<PosMode>("retail");
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [prescription, setPrescription] = useState<Prescription | null>(null);
  const [notes, setNotes] = useState("");
  const [quickTab, setQuickTab] = useState<QuickAddTab>("top");

  const [tenderMode, setTenderMode] = useState<TenderMode>("cash");
  const [posPrefs, setPosPrefs] = useState({
    posQuickAddEnabled: true,
    posHeldSalesEnabled: true,
    posRequireCustomer: false,
    posAutoPrintReceipt: true,
  });
  const [receiptPrefs, setReceiptPrefs] = useState<ReceiptPreferences>({
    paperSize: "80mm",
    headerText: null,
    footerText: null,
    showLogo: true,
    showVatBreakdown: true,
    showStaffName: true,
  });
  const [organization, setOrganization] = useState<{ displayName: string; logoUrl: string | null } | null>(null);
  const [amountPaid, setAmountPaid] = useState("0.00");
  const [paidTouched, setPaidTouched] = useState(false);
  const [splitAmounts, setSplitAmounts] = useState<Record<PaymentMethod, string>>(EMPTY_SPLIT);

  const [customerOpen, setCustomerOpen] = useState(false);
  const [rxOpen, setRxOpen] = useState(false);
  const [holdsOpen, setHoldsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [batchLine, setBatchLine] = useState<ResolvedCartLine | null>(null);
  const [lookupMode, setLookupMode] = useState<LookupMode | null>(null);
  const [receipt, setReceipt] = useState<SaleReceipt | null>(null);
  const [lastReceipt, setLastReceipt] = useState<SaleReceipt | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [posting, setPosting] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [tillPinSettingsOpen, setTillPinSettingsOpen] = useState(false);
  /** Set while the cart holds an un-modified recall; cleared on any new hold/sale/reset. */
  const [recalledHold, setRecalledHold] = useState<{ id: string; holdRef: string } | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  const idempotencyKey = useRef(newIdempotencyKey());
  const seededDeepLink = useRef(false);

  const canRecordRx = canAccess([...RX_ROLES]);
  const canDispenseControlled = canAccess([...RX_ROLES]);
  const { alerts, blockingAlerts, needsPharmacistPin, softRxWarnings } = usePosAlerts({
    lines: cart.resolved,
    prescription,
    customer,
    mode,
    canDispenseControlled,
  });
  const rxRequired = cart.resolved.some(
    (line) => line.product.requiresPrescription || line.product.isControlled,
  );
  const cashierName = user?.fullName ?? "Cashier";

  useEffect(() => {
    let cancelled = false;
    fetchTenantSettings()
      .then((settings) => {
        if (cancelled) return;
        setPosPrefs({
          posQuickAddEnabled: settings.posQuickAddEnabled,
          posHeldSalesEnabled: settings.posHeldSalesEnabled,
          posRequireCustomer: settings.posRequireCustomer,
          posAutoPrintReceipt: settings.posAutoPrintReceipt,
        });
        setReceiptPrefs({
          paperSize: settings.receiptPaperSize,
          headerText: settings.receiptHeaderText,
          footerText: settings.receiptFooterText,
          showLogo: settings.receiptShowLogo,
          showVatBreakdown: settings.receiptShowVatBreakdown,
          showStaffName: settings.receiptShowStaffName,
        });
        if (["cash", "card", "mobile_wallet", "split"].includes(settings.posDefaultPaymentMethod)) {
          setTenderMode(settings.posDefaultPaymentMethod as TenderMode);
        }
      })
      .catch(() => {});
    apiJson<{ displayName: string; logoUrl: string | null }>("/tenant/profile")
      .then((profile) => { if (!cancelled) setOrganization(profile); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  /* ── Cart operations ─────────────────────────────────────── */

  const addProduct = useCallback(
    (product: PosProduct, qty = 1) => {
      const result = cart.addProduct(product, qty);
      if (result.status === "no-stock") {
        beep("error");
        toasts.error(`${product.name} has no sellable stock at this branch.`);
        return;
      }
      if (result.status === "capped") {
        beep("error");
        toasts.warn(`Only ${result.available} of ${product.name} left in that batch.`);
      } else {
        beep("ok");
      }
      searchRef.current?.focus();
    },
    [cart, beep, toasts],
  );

  const resetSale = useCallback(() => {
    cart.clear();
    setCustomer(null);
    setPrescription(null);
    setNotes("");
    setTenderMode("cash");
    setAmountPaid("0.00");
    setPaidTouched(false);
    setSplitAmounts(EMPTY_SPLIT);
    setRecalledHold(null);
    idempotencyKey.current = newIdempotencyKey();
    searchRef.current?.focus();
  }, [cart]);

  // Deep link from a product page: /pos?productId=…
  useEffect(() => {
    if (seededDeepLink.current || !deepProductId || products.length === 0) return;
    const product = productsById.get(deepProductId);
    seededDeepLink.current = true;
    if (product) {
      addProduct(product);
    } else {
      toasts.warn("That product has no sellable stock at this branch.");
    }
  }, [deepProductId, products.length, productsById, addProduct, toasts]);

  // Keep the tendered amount in step with the total until the cashier types.
  useEffect(() => {
    if (paidTouched) return;
    setAmountPaid(cart.totals.grandTotal.toFixed(2));
  }, [cart.totals.grandTotal, paidTouched]);

  useEffect(() => {
    if (holds.error) toasts.error(holds.error);
  }, [holds.error, toasts]);

  useEffect(() => {
    if (cart.unresolvedCount > 0) {
      toasts.warn(
        `${cart.unresolvedCount} line(s) were dropped — that stock is no longer sellable.`,
      );
    }
    // Only announce when the count changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart.unresolvedCount]);

  /* ── Hold / recall ───────────────────────────────────────── */

  const holdSale = useCallback(
    async (opts?: { forPharmacist?: boolean }) => {
      if (cart.resolved.length === 0) return;
      if (!posPrefs.posHeldSalesEnabled) {
        toasts.warn("Held sales are disabled in Settings.");
        return;
      }
      const forPharmacist = opts?.forPharmacist === true;
      try {
        const labelBase =
          customer?.fullName ??
          `${cart.resolved[0]!.product.name}${cart.resolved.length > 1 ? ` +${cart.resolved.length - 1}` : ""}`;
        const label = forPharmacist ? `Rx · ${labelBase}` : labelBase;
        const holdReason: HoldReason = forPharmacist ? "awaiting_pharmacist" : "parked";
        const created = await createHold({
          label,
          itemCount: cart.resolved.length,
          total: cart.totals.grandTotal.toFixed(2),
          lines: cart.lines as unknown as CartLine[],
          meta: {
            mode: mode === "returns" ? "retail" : mode,
            customerId: customer?.id ?? null,
            prescriptionId: prescription?.id ?? null,
            notes: notes || null,
            holdReason,
            needsPharmacist: forPharmacist,
          },
        });
        toasts.success(
          forPharmacist
            ? `Parked as ${created.holdRef} — awaiting pharmacist.`
            : `Parked as ${created.holdRef}.`,
        );
        setPinOpen(false);
        resetSale();
        void holds.reload();
      } catch (e) {
        toasts.error(e instanceof Error ? e.message : "Could not park this sale");
      }
    },
    [cart, customer, prescription, notes, mode, toasts, resetSale, holds, posPrefs.posHeldSalesEnabled],
  );

  const recallHold = useCallback(
    async (id: string) => {
      try {
        // Consumes the hold server-side first — it's gone from the parked list
        // the instant this resolves, so it can never be recalled a second time.
        const detail = await holds.recall(id);
        // The hold's payload is stored as untyped JSON (Prisma.InputJsonValue) —
        // rows written outside the normal park-cart flow (e.g. seed data) can omit
        // key/discountPercent/addedAt, which silently turns totals into NaN
        // (formatMoney then renders that as "0.00") once resolveLine runs the math.
        const restored: CartLine[] = detail.payload.lines
          .filter((line) => {
            const product = productsById.get(line.productId);
            return Boolean(product?.batches.some((b) => b.id === line.batchId));
          })
          .map((line, i) => ({
            key: line.key || makeLineKey(line.productId, line.batchId),
            productId: line.productId,
            batchId: line.batchId,
            qty: line.qty,
            unitPrice: Number(line.unitPrice) || 0,
            discountPercent: Number(line.discountPercent) || 0,
            addedAt: line.addedAt ?? Date.now() + i,
          }));
        const dropped = detail.payload.lines.length - restored.length;
        const meta = detail.payload.meta;

        // The hold only stores ids — refetch the full customer/prescription so
        // compliance state (e.g. controlled-item alerts) is correct after recall
        // instead of silently falling back to "no customer / no prescription".
        const [restoredCustomer, restoredPrescription] = await Promise.all([
          meta.customerId ? getCustomer(meta.customerId).catch(() => null) : Promise.resolve(null),
          meta.prescriptionId
            ? getPrescription(meta.prescriptionId).catch(() => null)
            : Promise.resolve(null),
        ]);

        cart.replaceAll(restored);
        setCustomer(restoredCustomer);
        setPrescription(restoredPrescription);
        setNotes(meta.notes ?? "");
        setMode(meta.mode === "returns" ? "retail" : (meta.mode ?? "retail"));
        setRecalledHold({ id: detail.id, holdRef: detail.holdRef });
        setPaidTouched(false);
        setHoldsOpen(false);

        const lostLinks =
          (meta.customerId && !restoredCustomer ? 1 : 0) +
          (meta.prescriptionId && !restoredPrescription ? 1 : 0);
        toasts.success(
          dropped > 0
            ? `Recalled ${detail.holdRef}; ${dropped} line(s) are no longer sellable.`
            : lostLinks > 0
              ? `Recalled ${detail.holdRef}; the linked customer/prescription is no longer available.`
              : `Recalled ${detail.holdRef}.`,
        );
        searchRef.current?.focus();
      } catch (e) {
        toasts.error(e instanceof Error ? e.message : "Could not recall that sale");
      }
    },
    [holds, productsById, cart, toasts],
  );

  // Dashboard quick actions / row clicks:
  // /pos?panel=holds[&holdId=]|customer&mode=returns&focus=search&invoice=
  const panelDeepLinkApplied = useRef(false);
  useEffect(() => {
    if (panelDeepLinkApplied.current) return;
    if (!deepPanel && !deepMode && !deepFocus && !deepInvoice) return;
    // Recall's stock-availability check reads productsById, which is empty
    // until the catalog finishes loading — recalling before then would drop
    // every line as "no longer sellable" even when the stock is fine.
    if (deepPanel === "holds" && deepHoldId && products.length === 0) return;
    // recentSales loads alongside the catalog — wait for it so a fresh
    // deep-link doesn't decide "no receipt" before the fetch resolves.
    if (deepPanel === "receipt" && !lastReceipt && loading) return;
    panelDeepLinkApplied.current = true;

    if (deepMode === "returns" || deepMode === "retail" || deepMode === "prescription") {
      setMode(deepMode);
    }
    if (deepPanel === "holds") {
      if (deepHoldId) void recallHold(deepHoldId);
      else setHoldsOpen(true);
    }
    if (deepPanel === "customer") setCustomerOpen(true);
    if (deepPanel === "receipt") {
      if (lastReceipt) {
        setReceipt(lastReceipt);
      } else if (recentSales[0]) {
        void findSaleByInvoice(recentSales[0].invoiceNo)
          .then(setReceipt)
          .catch(() => toasts.error("Could not open the last receipt"));
      } else {
        toasts.error("No recent receipt to show yet");
      }
    }
    if (deepInvoice) {
      void findSaleByInvoice(deepInvoice)
        .then(setReceipt)
        .catch(() => toasts.error("Could not open that invoice"));
    }
    if (deepFocus === "search") {
      window.setTimeout(() => searchRef.current?.focus(), 0);
    }

    const next = new URLSearchParams(searchParams.toString());
    next.delete("panel");
    next.delete("mode");
    next.delete("focus");
    next.delete("holdId");
    next.delete("invoice");
    const qs = next.toString();
    router.replace(qs ? `/pos?${qs}` : "/pos", { scroll: false });
  }, [
    deepFocus,
    deepHoldId,
    deepInvoice,
    deepMode,
    deepPanel,
    lastReceipt,
    loading,
    products.length,
    recallHold,
    recentSales,
    router,
    searchParams,
    toasts,
  ]);

  /* ── Checkout ────────────────────────────────────────────── */

  const blockedReason = useMemo(() => {
    if (cart.resolved.length === 0) return null;
    if (blockingAlerts.length > 0) return blockingAlerts[0]!.title;
    if (posPrefs.posRequireCustomer && !customer) return "Select a customer before completing this sale";
    return null;
  }, [cart.resolved.length, blockingAlerts, posPrefs.posRequireCustomer, customer]);

  const buildPayments = useCallback((): TenderLine[] => {
    const total = cart.totals.grandTotal;
    if (tenderMode === "split") {
      return PAYMENT_METHODS.map((method) => ({
        method: method.value,
        amount: (Number(splitAmounts[method.value]) || 0).toFixed(2),
      })).filter((tender) => Number(tender.amount) > 0);
    }
    if (tenderMode === "cash") {
      const paid = Math.max(Number(amountPaid) || 0, total);
      return [{ method: "cash", amount: paid.toFixed(2) }];
    }
    return [{ method: tenderMode, amount: total.toFixed(2) }];
  }, [tenderMode, splitAmounts, amountPaid, cart.totals.grandTotal]);

  const postCheckout = useCallback(
    async (pharmacistApproval?: PharmacistApproval) => {
      setPosting(true);
      try {
        const sale = await checkout(
          {
            items: cart.resolved.map((line) => ({
              productId: line.productId,
              batchId: line.batchId,
              qty: line.qty,
              unitPrice: line.unitPrice.toFixed(2),
              discountAmount: line.discountAmount.toFixed(2),
            })),
            customerId: customer?.id,
            prescriptionId: prescription?.id,
            notes: notes.trim() || undefined,
            payments: buildPayments(),
            heldSaleId: recalledHold?.id ?? undefined,
            pharmacistApproval,
          },
          idempotencyKey.current,
        );
        setPinOpen(false);
        if (posPrefs.posAutoPrintReceipt) setReceipt(sale);
        setLastReceipt(sale);
        const dispenserNote =
          sale.dispenser && sale.dispenser.id !== sale.seller.id
            ? ` · dispensed by ${sale.dispenser.fullName}`
            : "";
        toasts.success(
          `${sale.invoiceNo} posted — ${formatMoney(sale.grandTotal)}${dispenserNote}.`,
        );
        resetSale();
        void reload();
        void holds.reload();
      } catch (e) {
        beep("error");
        toasts.error(e instanceof Error ? e.message : "Checkout failed");
        throw e;
      } finally {
        setPosting(false);
      }
    },
    [
      cart.resolved,
      customer,
      prescription,
      notes,
      buildPayments,
      recalledHold,
      toasts,
      resetSale,
      reload,
      holds,
      beep,
      posPrefs.posAutoPrintReceipt,
    ],
  );

  const completeSale = useCallback(async () => {
    if (posting || cart.resolved.length === 0) return;
    if (blockedReason) {
      beep("error");
      toasts.error(blockedReason);
      return;
    }
    const total = cart.totals.grandTotal;
    if (tenderMode === "cash") {
      const paid = Number(amountPaid) || 0;
      if (paid + 0.004 < total) {
        beep("error");
        toasts.error(`Tender is short by ${formatMoney(total - paid)}.`);
        return;
      }
    }
    if (tenderMode === "split") {
      const paid = PAYMENT_METHODS.reduce(
        (sum, m) => sum + (Number(splitAmounts[m.value]) || 0),
        0,
      );
      if (paid + 0.004 < total) {
        beep("error");
        toasts.error(`Tender is short by ${formatMoney(total - paid)}.`);
        return;
      }
    }
    // Cashier path: open PIN modal instead of dead-ending Complete Sale.
    if (needsPharmacistPin) {
      setPinOpen(true);
      return;
    }
    try {
      await postCheckout();
    } catch {
      /* toast already shown */
    }
  }, [
    posting,
    cart.resolved.length,
    cart.totals.grandTotal,
    blockedReason,
    tenderMode,
    amountPaid,
    splitAmounts,
    needsPharmacistPin,
    postCheckout,
    toasts,
    beep,
  ]);

  const onAlertAction = useCallback(
    (kind: PosAlertActionKind) => {
      if (kind === "link_rx") {
        setRxOpen(true);
        return;
      }
      if (kind === "pharmacist_pin") {
        setPinOpen(true);
        return;
      }
      if (kind === "hold_pharmacist") {
        void holdSale({ forPharmacist: true });
      }
    },
    [holdSale],
  );

  /* ── Confirm-guarded destructive actions ─────────────────── */

  const guard = useCallback(
    (next: Confirm) => {
      if (cart.resolved.length === 0) {
        next.onConfirm();
        return;
      }
      setConfirm(next);
    },
    [cart.resolved.length],
  );

  const startNewSale = useCallback(() => {
    guard({
      title: "Start a new sale?",
      message: "The current cart has unsold items. They will be discarded.",
      confirmLabel: "Discard and start new",
      onConfirm: resetSale,
    });
  }, [guard, resetSale]);

  const clearCart = useCallback(() => {
    guard({
      title: "Clear the cart?",
      message: "Every line, the customer, and the linked prescription will be removed.",
      confirmLabel: "Clear cart",
      onConfirm: resetSale,
    });
  }, [guard, resetSale]);

  /* ── Keyboard map ────────────────────────────────────────── */

  const anyOverlayOpen =
    customerOpen ||
    rxOpen ||
    holdsOpen ||
    shortcutsOpen ||
    pinOpen ||
    tillPinSettingsOpen ||
    confirm !== null ||
    batchLine !== null ||
    lookupMode !== null ||
    receipt !== null;

  const saleMode = mode !== "returns";

  // Overlays own their keyboard: F4 must never post a sale from behind a modal.
  // Returns mode also disables sale shortcuts so a hidden cart cannot be posted.
  usePosShortcuts(
    {
      focusSearch: () => {
        if (saleMode) searchRef.current?.focus();
      },
      priceCheck: () => {
        if (saleMode) setLookupMode("price");
      },
      completeSale: () => {
        if (saleMode) void completeSale();
      },
      holdSale: () => {
        if (saleMode) void holdSale();
      },
      recallSale: () => {
        if (!saleMode) return;
        setHoldsOpen(true);
        void holds.reload();
      },
      newSale: () => {
        if (saleMode) startNewSale();
      },
      cyclePayment: () => {
        if (!saleMode) return;
        setTenderMode((prev) => {
          const order: TenderMode[] = ["cash", "card", "mobile_wallet", "split"];
          return order[(order.indexOf(prev) + 1) % order.length]!;
        });
      },
      customerLookup: () => {
        if (saleMode) setCustomerOpen(true);
      },
      linkPrescription: () => {
        if (saleMode) setRxOpen(true);
      },
      clearCart: () => {
        if (saleMode) clearCart();
      },
      toggleShortcuts: () => setShortcutsOpen((prev) => !prev),
      escape: () => {
        if (saleMode) searchRef.current?.focus();
      },
    },
    !anyOverlayOpen,
  );

  /* ── Render ──────────────────────────────────────────────── */

  if (!hasBranch) {
    return (
      <p className={css.branchNotice}>
        Select a branch from the top bar to open the counter. Stock, prices, and invoices are all
        branch-scoped.
      </p>
    );
  }

  return (
    <div className={css.page}>
      <div className={css.topBar}>
        <PosSearchBar
          products={products}
          mode={mode}
          onModeChange={setMode}
          onSelect={(product) => {
            if (mode === "returns") return;
            addProduct(product);
          }}
          inputRef={searchRef}
          disabled={loading || mode === "returns"}
          searchDisabled={mode === "returns"}
        />
        <PosActionBar
          cartDirty={cart.resolved.length > 0}
          holdCount={holds.holds.length}
          busy={posting}
          holdsEnabled={posPrefs.posHeldSalesEnabled}
          beepEnabled={beepEnabled}
          saleActionsDisabled={mode === "returns"}
          onNewSale={startNewSale}
          onHold={() => void holdSale()}
          onRecall={() => {
            setHoldsOpen(true);
            void holds.reload();
          }}
          onClear={clearCart}
          onShortcuts={() => setShortcutsOpen(true)}
          onToggleBeep={toggleBeep}
        />
      </div>

      {error && <p className={css.branchNotice}>{error}</p>}

      {mode === "returns" ? (
        <PosReturnsPanel
          canRefund={canAccess([...POS_ROLES])}
          canRefundControlled={canAccess(["owner", "manager", "pharmacist"])}
          recentSales={recentSales}
          onRefunded={() => void reload()}
          onError={toasts.error}
          onNotice={toasts.success}
        />
      ) : (
        <div className={css.workspace}>
          <div className={css.mainCol}>
            <PosCartPanel
              invoiceLabel={draftInvoiceLabel()}
              lines={cart.resolved}
              mode={mode}
              customer={customer}
              prescription={prescription}
              cashierName={cashierName}
              cashierInitials={initialsOf(cashierName)}
              notes={notes}
              rxRequired={rxRequired}
              recalledHoldRef={recalledHold?.holdRef ?? null}
              lastAddedKey={cart.lastTouchedKey}
              addCount={cart.addCount}
              onNotesChange={setNotes}
              onOpenCustomer={() => setCustomerOpen(true)}
              onOpenPrescription={() => setRxOpen(true)}
              onOpenBatch={setBatchLine}
              onStepQty={cart.stepQty}
              onSetQty={cart.setQty}
              onSetDiscount={cart.setDiscountPercent}
              onRemove={cart.removeLine}
            />

            {posPrefs.posQuickAddEnabled && <PosQuickAdd
              tab={quickTab}
              onTabChange={setQuickTab}
              products={products}
              departments={departments}
              recentSales={recentSales}
              cartLines={cart.resolved}
              onAdd={(product) => addProduct(product)}
              onRepeatSale={(sale: RecentSale) => {
                let added = 0;
                let skipped = 0;
                for (const id of sale.productIds) {
                  const product = productsById.get(id);
                  if (!product) {
                    skipped += 1;
                    continue;
                  }
                  const result = cart.addProduct(product, 1);
                  if (result.status === "no-stock") skipped += 1;
                  else added += 1;
                }
                if (added > 0) {
                  beep(skipped > 0 ? "error" : "ok");
                  toasts.success(
                    skipped > 0
                      ? `Loaded ${added} item(s) from ${sale.invoiceNo}; ${skipped} unavailable.`
                      : `Loaded ${added} item(s) from ${sale.invoiceNo}.`,
                  );
                } else {
                  beep("error");
                  toasts.warn(`Nothing from ${sale.invoiceNo} is sellable right now.`);
                }
              }}
            />}
          </div>

          <div className={css.sideCol}>
            <PosSummaryPanel
              totals={cart.totals}
              vatRatePercent={vatRatePercent}
              tenderMode={tenderMode}
              onTenderModeChange={setTenderMode}
              amountPaid={amountPaid}
              onAmountPaidChange={(value) => {
                setPaidTouched(true);
                setAmountPaid(value);
              }}
              splitAmounts={splitAmounts}
              onSplitChange={(method, value) =>
                setSplitAmounts((prev) => ({ ...prev, [method]: value }))
              }
              busy={posting}
              blockedReason={blockedReason}
              approveHint={
                needsPharmacistPin
                  ? "Pharmacist till PIN required — Complete opens co-sign."
                  : null
              }
              hasLastReceipt={lastReceipt !== null}
              onComplete={() => void completeSale()}
              onPrint={() => {
                if (lastReceipt) setReceipt(lastReceipt);
                else toasts.notify("Complete the sale to print its bill.");
              }}
              onHold={() => void holdSale()}
              holdsEnabled={posPrefs.posHeldSalesEnabled}
            />

            <PosAlertsPanel
              alerts={alerts}
              cartEmpty={cart.resolved.length === 0}
              onAction={onAlertAction}
            />

            <PosQuickActions
              onPriceCheck={() => setLookupMode("price")}
              onOpenDrawer={() => toasts.notify("Cash drawer pulse sent to the till.")}
              onLastReceipt={() => setReceipt(lastReceipt)}
              onManualItem={() => setLookupMode("manual")}
              hasLastReceipt={lastReceipt !== null}
              canSetPosPin={canDispenseControlled}
              onSetPosPin={() => setTillPinSettingsOpen(true)}
            />
          </div>
        </div>
      )}

      <PosCustomerModal
        open={customerOpen}
        selectedId={customer?.id ?? null}
        onClose={() => setCustomerOpen(false)}
        onSelect={setCustomer}
        onError={toasts.error}
      />

      <PosPrescriptionModal
        open={rxOpen}
        selectedId={prescription?.id ?? null}
        customer={customer}
        canCreate={canRecordRx}
        onClose={() => setRxOpen(false)}
        onSelect={setPrescription}
        onError={toasts.error}
      />

      <PosBatchModal
        line={batchLine}
        onClose={() => setBatchLine(null)}
        onPick={(batch) => {
          if (batchLine) cart.changeBatch(batchLine.key, batch, batchLine.productId);
        }}
      />

      <PosPharmacistPinModal
        open={pinOpen}
        warnings={softRxWarnings}
        onClose={() => setPinOpen(false)}
        onHoldInstead={() => void holdSale({ forPharmacist: true })}
        onError={toasts.error}
        onApprove={(approval) => postCheckout(approval)}
      />

      <PosSetPinModal
        open={tillPinSettingsOpen}
        onClose={() => setTillPinSettingsOpen(false)}
        onSaved={() => toasts.success("Till PIN saved.")}
        onError={toasts.error}
      />

      <PosHoldsModal
        open={holdsOpen}
        holds={holds.holds}
        loading={holds.loading}
        onClose={() => setHoldsOpen(false)}
        onRecall={(hold) => void recallHold(hold.id)}
        onDiscard={(hold) => {
          void holds
            .discard(hold.id)
            .then(() => toasts.notify(`Discarded ${hold.holdRef}.`))
            .catch((e: unknown) =>
              toasts.error(e instanceof Error ? e.message : "Could not discard that hold"),
            );
        }}
      />

      <PosLookupModal
        mode={lookupMode}
        products={products}
        onClose={() => setLookupMode(null)}
        onAddManual={(product, qty, unitPrice) => {
          const result = cart.addProduct(product, qty);
          if (result.status === "no-stock") {
            toasts.error(`${product.name} has no sellable stock.`);
            return;
          }
          cart.setUnitPrice(result.key, unitPrice);
          beep("ok");
          toasts.success(`${product.name} added at ${formatMoney(unitPrice)}.`);
        }}
      />

      <PosShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />

      <PosReceiptModal
        receipt={receipt}
        onClose={() => setReceipt(null)}
        preferences={receiptPrefs}
        organization={organization}
      />

      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm?.title ?? ""}
        size="sm"
        elevated
        footer={
          <ModalFooter>
            <ModalButton onClick={() => setConfirm(null)}>Keep the cart</ModalButton>
            <ModalButton
              variant="danger"
              onClick={() => {
                confirm?.onConfirm();
                setConfirm(null);
              }}
            >
              {confirm?.confirmLabel ?? "Confirm"}
            </ModalButton>
          </ModalFooter>
        }
      >
        <p className={css.fieldHint}>{confirm?.message}</p>
      </Modal>

      <PosToasts toasts={toasts.toasts} />
    </div>
  );
}

export default function PosPage() {
  return (
    <RolePageGuard roles={POS_ROLES} permissions={["sales.pos_use"]}>
      <Suspense fallback={<p className={css.loading}>Opening the counter…</p>}>
        <PosWorkspace />
      </Suspense>
    </RolePageGuard>
  );
}
