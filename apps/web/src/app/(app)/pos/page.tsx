"use client";

import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Modal, ModalButton, ModalFooter } from "@/components/ui";
import { RolePageGuard } from "@/components/role-access";
import { POS_ROLES } from "@/lib/role-access";
import { useAuth } from "@/lib/use-auth";
import { hasPermission, usePermissions } from "@/lib/permissions";
import { useRoleAccess } from "@/lib/use-role-access";
import { usePageChrome } from "@/lib/page-chrome-context";
import { PosBatchModal } from "./components/pos-batch-modal";
import { PosCustomerModal } from "./components/pos-customer-modal";
import { PosHoldsModal } from "./components/pos-holds-modal";
import { PosLookupModal, type LookupMode } from "./components/pos-lookup-modal";
import {
  PosDonePanel,
  PosIdlePanel,
  PosPayPanel,
  type LastSaleSummary,
  type TenderMode,
} from "./components/pos-pay-panel";
import { PosPharmacistPinModal } from "./components/pos-pharmacist-pin-modal";
import { PosPrescriptionModal } from "./components/pos-prescription-modal";
import { PosReceiptModal, type ReceiptPreferences } from "./components/pos-receipt-modal";
import { PosReturnsPanel } from "./components/pos-returns-panel";
import { PosSearchBar } from "./components/pos-search-bar";
import { PosSetPinModal } from "./components/pos-set-pin-modal";
import { PosShortcutsModal } from "./components/pos-shortcuts-modal";
import { PosCompletedTicket, PosTicket } from "./components/pos-ticket";
import { PosTillBar, type TillMode } from "./components/pos-till-bar";
import { PosToasts } from "./components/pos-toasts";
import { PAYMENT_METHODS, PAYMENT_METHOD_LABELS } from "./constants";
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
  HeldSaleSummary,
  HoldReason,
  PaymentMethod,
  PharmacistApproval,
  PosAlertActionKind,
  PosProduct,
  Prescription,
  ResolvedCartLine,
  SaleReceipt,
  TenderLine,
} from "./types";
import { formatAmount, formatMoney, makeLineKey, newIdempotencyKey } from "./utils";
import css from "./pos.module.css";
import tcss from "./till.module.css";

const RX_ROLES = ["owner", "manager", "pharmacist"] as const;

// v2: focus mode became the default with the till redesign, so an old "off" is not carried over.
const FOCUS_MODE_KEY = "pc_pos_focus_mode_v2";

/** The till opens in focus mode unless this browser's cashier switched it off. */
function readFocusMode(): boolean {
  try {
    return localStorage.getItem(FOCUS_MODE_KEY) !== "0";
  } catch {
    return true;
  }
}

const EMPTY_SPLIT: Record<PaymentMethod, string> = {
  cash: "",
  card: "",
  mobile_wallet: "",
};

const ROLE_LABELS: Array<[string, string]> = [
  ["owner", "Owner"],
  ["manager", "Manager"],
  ["pharmacist", "Pharmacist"],
  ["cashier", "Cashier"],
  ["inventory_clerk", "Inventory clerk"],
];

type Confirm = {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
};

/**
 * Size the till to the space under the app's chrome, so the page never scrolls — the ticket and
 * the pay panel scroll inside themselves instead.
 */
function useFillViewport(ref: React.RefObject<HTMLDivElement>, deps: unknown[]) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      if (window.innerWidth <= 960) {
        el.style.height = "";
        return;
      }
      const top = el.getBoundingClientRect().top + window.scrollY;
      el.style.height = `${Math.max(window.innerHeight - top, 480)}px`;
    };
    fit();
    window.addEventListener("resize", fit);
    // The shell's chrome slides in and out (focus mode), moving the till without a resize.
    document.addEventListener("transitionend", fit);
    const observer = new ResizeObserver(fit);
    observer.observe(document.body);
    if (el.parentElement) observer.observe(el.parentElement);
    const frame = window.requestAnimationFrame(fit);
    return () => {
      window.removeEventListener("resize", fit);
      document.removeEventListener("transitionend", fit);
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

function PosWorkspace() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const deepProductId = searchParams.get("productId");
  const deepCustomerId = searchParams.get("customerId");
  const deepPanel = searchParams.get("panel");
  const deepMode = searchParams.get("mode");
  const deepFocus = searchParams.get("focus");
  const deepHoldId = searchParams.get("holdId");
  const deepInvoice = searchParams.get("invoice");

  const { user, branchId } = useAuth();
  const { canAccess } = useRoleAccess();
  const { permissionKeys } = usePermissions();
  const { setChromeHidden } = usePageChrome();
  const toasts = usePosToasts();
  const { beep, beepEnabled, toggleBeep } = useScanBeep();

  const { products, productsById, vatRatePercent, recentSales, loading, error, hasBranch, reload } =
    usePosCatalog();
  const cart = usePosCart(productsById, vatRatePercent);
  const holds = usePosHolds();

  const [mode, setMode] = useState<TillMode>("sale");
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [prescription, setPrescription] = useState<Prescription | null>(null);
  const [notes, setNotes] = useState("");
  const [scannedKey, setScannedKey] = useState<string | null>(null);

  const [tenderMode, setTenderMode] = useState<TenderMode>("cash");
  const [defaultTender, setDefaultTender] = useState<TenderMode>("cash");
  const [posPrefs, setPosPrefs] = useState({
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
  const [tenderRef, setTenderRef] = useState("");

  const [customerOpen, setCustomerOpen] = useState(false);
  const [rxOpen, setRxOpen] = useState(false);
  const [holdsOpen, setHoldsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [focusMode, setFocusMode] = useState(true);
  const [batchLine, setBatchLine] = useState<ResolvedCartLine | null>(null);
  const [lookupMode, setLookupMode] = useState<LookupMode | null>(null);
  const [receipt, setReceipt] = useState<SaleReceipt | null>(null);
  const [autoPrintReceipt, setAutoPrintReceipt] = useState(false);
  const [lastReceipt, setLastReceipt] = useState<SaleReceipt | null>(null);
  /** The sale just completed — its change and receipt stay up until the next scan or New sale. */
  const [completedSale, setCompletedSale] = useState<SaleReceipt | null>(null);
  const [completedPrinted, setCompletedPrinted] = useState(false);
  const [returnsInvoice, setReturnsInvoice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [posting, setPosting] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [tillPinSettingsOpen, setTillPinSettingsOpen] = useState(false);
  /** Set while the cart holds an un-modified recall; cleared on any new hold/sale/reset. */
  const [recalledHold, setRecalledHold] = useState<{ id: string; holdRef: string } | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const idempotencyKey = useRef(newIdempotencyKey());
  const seededDeepLink = useRef(false);
  const seededCustomerDeepLink = useRef(false);

  useFillViewport(rootRef, [focusMode, hasBranch, error]);

  const canRecordRx = canAccess([...RX_ROLES]);
  const canDispenseControlled = canAccess([...RX_ROLES]);
  const { alerts, blockingAlerts, needsPharmacistPin, softRxWarnings } = usePosAlerts({
    lines: cart.resolved,
    prescription,
    customer,
    canDispenseControlled,
  });
  const rxNeededCount = cart.resolved.filter(
    (line) => line.product.requiresPrescription || line.product.isControlled,
  ).length;
  const cashierName = user?.fullName ?? "Cashier";
  const roleLabel = useMemo(() => {
    const mine = new Set(
      (user?.branchRoles ?? []).filter((r) => r.branchId === branchId).map((r) => r.role),
    );
    return ROLE_LABELS.find(([key]) => mine.has(key))?.[1] ?? "Counter";
  }, [user, branchId]);

  useEffect(() => {
    let cancelled = false;
    fetchTenantSettings()
      .then((settings) => {
        if (cancelled) return;
        setPosPrefs({
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
          setDefaultTender(settings.posDefaultPaymentMethod as TenderMode);
        }
      })
      .catch(() => {});
    apiJson<{ displayName: string; logoUrl: string | null }>("/tenant/profile")
      .then((profile) => {
        if (!cancelled) setOrganization(profile);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Focus mode is the till's default; restore this browser's choice, keep AppShell's chrome in
  // step, and always give the chrome back on the way out so no other page loses its sidebar.
  useEffect(() => {
    setFocusMode(readFocusMode());
    return () => setChromeHidden(false);
  }, [setChromeHidden]);

  useEffect(() => {
    setChromeHidden(focusMode);
  }, [focusMode, setChromeHidden]);

  const toggleFocusMode = useCallback(() => {
    setFocusMode((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(FOCUS_MODE_KEY, next ? "1" : "0");
      } catch {}
      return next;
    });
  }, []);

  /* ── Cart operations ─────────────────────────────────────── */

  const addProduct = useCallback(
    (product: PosProduct, qty = 1) => {
      // Scanning after a sale starts the next one.
      setCompletedSale(null);
      const result = cart.addProduct(product, qty);
      if (result.status === "no-stock") {
        beep("error");
        toasts.error(`${product.name} has no sellable stock at this branch.`);
        return;
      }
      setScannedKey(result.key);
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
    setTenderMode(defaultTender);
    setAmountPaid("0.00");
    setPaidTouched(false);
    setSplitAmounts(EMPTY_SPLIT);
    setTenderRef("");
    setRecalledHold(null);
    setScannedKey(null);
    idempotencyKey.current = newIdempotencyKey();
    searchRef.current?.focus();
  }, [cart, defaultTender]);

  // Deep link from a product page: /pos?productId=…
  useEffect(() => {
    if (seededDeepLink.current || !deepProductId || products.length === 0) return;
    const product = productsById.get(deepProductId);
    seededDeepLink.current = true;
    if (product) addProduct(product);
    else toasts.warn("That product has no sellable stock at this branch.");
  }, [deepProductId, products.length, productsById, addProduct, toasts]);

  // Deep link from global search: /pos?customerId=… starts a sale for that customer.
  useEffect(() => {
    if (seededCustomerDeepLink.current || !deepCustomerId) return;
    seededCustomerDeepLink.current = true;
    getCustomer(deepCustomerId)
      .then((row) => setCustomer(row))
      .catch(() => toasts.warn("That customer is no longer available."));
  }, [deepCustomerId, toasts]);

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
      toasts.warn(`${cart.unresolvedCount} line(s) were dropped — that stock is no longer sellable.`);
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
          `${cart.resolved[0]!.product.name}${cart.resolved.length > 1 ? ` + ${cart.resolved.length - 1} more` : ""}`;
        const holdReason: HoldReason = forPharmacist ? "awaiting_pharmacist" : "parked";
        const created = await createHold({
          label: labelBase,
          itemCount: cart.resolved.length,
          total: cart.totals.grandTotal.toFixed(2),
          lines: cart.lines as unknown as CartLine[],
          meta: {
            mode: "retail",
            customerId: customer?.id ?? null,
            prescriptionId: prescription?.id ?? null,
            notes: notes || null,
            holdReason,
            needsPharmacist: forPharmacist,
          },
        });
        toasts.success(
          forPharmacist ? `Held as ${created.holdRef} for the pharmacist.` : `Held as ${created.holdRef}.`,
        );
        setPinOpen(false);
        resetSale();
        void holds.reload();
      } catch (e) {
        toasts.error(e instanceof Error ? e.message : "Could not hold this sale");
      }
    },
    [cart, customer, prescription, notes, toasts, resetSale, holds, posPrefs.posHeldSalesEnabled],
  );

  const recallHold = useCallback(
    async (id: string) => {
      try {
        // Consumes the hold server-side first — it's gone from the held list the instant this
        // resolves, so it can never be recalled a second time.
        const detail = await holds.recall(id);
        // The payload is untyped JSON — rows written outside the normal hold flow (seed data)
        // can omit key/discountPercent/addedAt, which would turn totals into NaN.
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

        // The hold only stores ids — refetch the customer and prescription so compliance state
        // is right after recall instead of silently "no customer / no prescription".
        const [restoredCustomer, restoredPrescription] = await Promise.all([
          meta.customerId ? getCustomer(meta.customerId).catch(() => null) : Promise.resolve(null),
          meta.prescriptionId ? getPrescription(meta.prescriptionId).catch(() => null) : Promise.resolve(null),
        ]);

        setCompletedSale(null);
        setMode("sale");
        cart.replaceAll(restored);
        setScannedKey(null);
        setCustomer(restoredCustomer);
        setPrescription(restoredPrescription);
        setNotes(meta.notes ?? "");
        setRecalledHold({ id: detail.id, holdRef: detail.holdRef });
        setPaidTouched(false);
        setHoldsOpen(false);

        const lostLinks =
          (meta.customerId && !restoredCustomer ? 1 : 0) + (meta.prescriptionId && !restoredPrescription ? 1 : 0);
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
  // /pos?panel=holds[&holdId=]|customer|receipt&mode=returns&focus=search&invoice=
  const panelDeepLinkApplied = useRef(false);
  useEffect(() => {
    if (panelDeepLinkApplied.current) return;
    if (!deepPanel && !deepMode && !deepFocus && !deepInvoice) return;
    // Recall checks stock against productsById, which is empty until the catalog loads.
    if (deepPanel === "holds" && deepHoldId && products.length === 0) return;
    // recentSales loads alongside the catalog — wait for it before deciding "no receipt".
    if (deepPanel === "receipt" && !lastReceipt && loading) return;
    panelDeepLinkApplied.current = true;

    if (deepMode === "returns") setMode("returns");
    else if (deepMode === "retail" || deepMode === "prescription" || deepMode === "sale") setMode("sale");
    if (deepPanel === "holds") {
      if (deepHoldId) void recallHold(deepHoldId);
      else setHoldsOpen(true);
    }
    if (deepPanel === "customer") setCustomerOpen(true);
    if (deepPanel === "receipt") {
      if (lastReceipt) setReceipt(lastReceipt);
      else if (recentSales[0]) {
        void findSaleByInvoice(recentSales[0].invoiceNo)
          .then(setReceipt)
          .catch(() => toasts.error("Could not open the last receipt"));
      } else toasts.error("No recent receipt to show yet");
    }
    if (deepInvoice) {
      void findSaleByInvoice(deepInvoice)
        .then(setReceipt)
        .catch(() => toasts.error("Could not open that invoice"));
    }
    if (deepFocus === "search") window.setTimeout(() => searchRef.current?.focus(), 0);

    const next = new URLSearchParams(searchParams.toString());
    for (const key of ["panel", "mode", "focus", "holdId", "invoice"]) next.delete(key);
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

  const blockedHint = useMemo(() => {
    if (cart.resolved.length === 0) return null;
    const first = blockingAlerts[0];
    if (first) {
      if (first.id === "rx-required") return "Link the prescription to complete this sale";
      if (first.id === "over-stock") return "Lower the quantity to what's in stock";
      if (first.id === "rx-expired") return "The linked prescription has expired";
      return first.title;
    }
    if (posPrefs.posRequireCustomer && !customer) return "Add a customer to complete this sale";
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
    const reference = tenderRef.trim();
    return [{ method: tenderMode, amount: total.toFixed(2), ...(reference ? { reference } : {}) }];
  }, [tenderMode, splitAmounts, amountPaid, cart.totals.grandTotal, tenderRef]);

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
        setLastReceipt(sale);
        setCompletedSale(sale);
        setCompletedPrinted(posPrefs.posAutoPrintReceipt);
        if (posPrefs.posAutoPrintReceipt) {
          setAutoPrintReceipt(true);
          setReceipt(sale);
        }
        if (sale.dispenser && sale.dispenser.id !== sale.seller.id) {
          toasts.success(`${sale.invoiceNo} dispensed by ${sale.dispenser.fullName}.`);
        }
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
    if (blockedHint) {
      beep("error");
      toasts.error(blockedHint);
      return;
    }
    const total = cart.totals.grandTotal;
    const paid =
      tenderMode === "cash"
        ? Number(amountPaid) || 0
        : tenderMode === "split"
          ? PAYMENT_METHODS.reduce((sum, m) => sum + (Number(splitAmounts[m.value]) || 0), 0)
          : total;
    if (paid + 0.004 < total) {
      beep("error");
      toasts.error(`${formatMoney(total - paid)} still to pay.`);
      return;
    }
    // A cashier with controlled items: the pharmacist co-signs here rather than the sale dead-ending.
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
    blockedHint,
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
      if (kind === "link_rx") setRxOpen(true);
      else if (kind === "pharmacist_pin") setPinOpen(true);
      else if (kind === "hold_pharmacist") void holdSale({ forPharmacist: true });
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
    setCompletedSale(null);
    guard({
      title: "Start a new sale?",
      message: "The current sale has items that haven't been paid for. They will be discarded.",
      confirmLabel: "Discard and start new",
      onConfirm: resetSale,
    });
  }, [guard, resetSale]);

  const clearCart = useCallback(() => {
    guard({
      title: "Clear this sale?",
      message: "Every line, the customer, and the linked prescription will be removed.",
      confirmLabel: "Clear sale",
      onConfirm: resetSale,
    });
  }, [guard, resetSale]);

  const lastSale: LastSaleSummary | null = useMemo(() => {
    if (lastReceipt) {
      const methods = [...new Set(lastReceipt.payments.filter((p) => Number(p.amount) > 0).map((p) => p.method))]
        .map((m) => PAYMENT_METHOD_LABELS[m])
        .join(" + ");
      const change = Number(lastReceipt.changeDue) || 0;
      return {
        invoiceNo: lastReceipt.invoiceNo,
        soldAt: lastReceipt.soldAt,
        grandTotal: lastReceipt.grandTotal,
        itemCount: lastReceipt.items.length,
        detail: `${methods}${change > 0 ? ` · change given ${formatAmount(change)}` : ""}`,
      };
    }
    const recent = recentSales[0];
    if (!recent) return null;
    return {
      invoiceNo: recent.invoiceNo,
      soldAt: recent.soldAt,
      grandTotal: recent.grandTotal,
      itemCount: recent.productIds.length,
      detail: recent.sellerName ? `by ${recent.sellerName}` : null,
    };
  }, [lastReceipt, recentSales]);

  const reprintLast = useCallback(() => {
    setAutoPrintReceipt(false);
    if (lastReceipt) {
      setReceipt(lastReceipt);
      return;
    }
    if (!recentSales[0]) {
      toasts.notify("No sale to reprint yet.");
      return;
    }
    void findSaleByInvoice(recentSales[0].invoiceNo)
      .then(setReceipt)
      .catch(() => toasts.error("Could not open the last receipt"));
  }, [lastReceipt, recentSales, toasts]);

  const openHolds = useCallback(() => {
    setHoldsOpen(true);
    void holds.reload();
  }, [holds]);

  const changeMode = useCallback((next: TillMode) => {
    setMode(next);
    if (next === "sale") window.setTimeout(() => searchRef.current?.focus(), 0);
  }, []);

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

  const saleMode = mode === "sale";

  // Overlays own their keyboard: F4 must never post a sale from behind a modal, and Returns
  // disables the sale keys so a hidden sale cannot be posted.
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
        if (saleMode && posPrefs.posHeldSalesEnabled) openHolds();
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
      toggleFocusMode,
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
        Select a branch from the top bar to open the counter. Stock, prices, and invoices are all branch-scoped.
      </p>
    );
  }

  const tillBar = (search: React.ReactNode, recentOpen = false, toggleRecent: () => void = () => {}) => (
    <PosTillBar
      mode={mode}
      onModeChange={changeMode}
      search={search}
      cashierName={cashierName}
      roleLabel={roleLabel}
      holdCount={holds.holds.length}
      holdsEnabled={posPrefs.posHeldSalesEnabled}
      onHeld={openHolds}
      onPriceCheck={() => setLookupMode("price")}
      recentRefundsOpen={recentOpen}
      onRecentRefunds={toggleRecent}
      focusMode={focusMode}
      onToggleFocus={toggleFocusMode}
      menu={{
        onNewSale: () => {
          changeMode("sale");
          startNewSale();
        },
        onOpenDrawer: () => toasts.notify("Cash drawer pulse sent to the till."),
        onManualItem: () => {
          changeMode("sale");
          setLookupMode("manual");
        },
        onReprintLast: lastSale ? reprintLast : null,
        onSetPin: canDispenseControlled ? () => setTillPinSettingsOpen(true) : null,
        beepEnabled,
        onToggleBeep: toggleBeep,
        onShortcuts: () => setShortcutsOpen(true),
      }}
    />
  );

  const saleBody = (
    <>
      {completedSale && cart.resolved.length === 0 ? (
        <PosCompletedTicket sale={completedSale} />
      ) : (
        <PosTicket
          lines={cart.resolved}
          totals={cart.totals}
          scannedKey={scannedKey}
          customer={customer}
          prescription={prescription}
          rxNeededCount={rxNeededCount}
          notes={notes}
          recalledHoldRef={recalledHold?.holdRef ?? null}
          products={products}
          recentSales={recentSales}
          onAddProduct={(product) => addProduct(product)}
          onNotesChange={setNotes}
          onOpenCustomer={() => setCustomerOpen(true)}
          onOpenPrescription={() => setRxOpen(true)}
          onOpenBatch={setBatchLine}
          onStepQty={cart.stepQty}
          onSetQty={cart.setQty}
          onSetDiscount={cart.setDiscountPercent}
          onRemove={cart.removeLine}
          onClear={clearCart}
        />
      )}

      {cart.resolved.length > 0 ? (
        <PosPayPanel
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
          onSplitChange={(method, value) => setSplitAmounts((prev) => ({ ...prev, [method]: value }))}
          tenderRef={tenderRef}
          onTenderRefChange={setTenderRef}
          alerts={alerts}
          onAlertAction={onAlertAction}
          blockedHint={blockedHint}
          busy={posting}
          onComplete={() => void completeSale()}
          onHold={() => void holdSale()}
          holdsEnabled={posPrefs.posHeldSalesEnabled}
        />
      ) : completedSale ? (
        <PosDonePanel
          sale={completedSale}
          printed={completedPrinted}
          onPrint={() => {
            setAutoPrintReceipt(false);
            setReceipt(completedSale);
            setCompletedPrinted(true);
          }}
          onNoReceipt={() => {
            setCompletedSale(null);
            searchRef.current?.focus();
          }}
          onNewSale={() => {
            setCompletedSale(null);
            resetSale();
          }}
        />
      ) : (
        <PosIdlePanel
          holds={holds.holds}
          holdsEnabled={posPrefs.posHeldSalesEnabled}
          onRecall={(hold: HeldSaleSummary) => void recallHold(hold.id)}
          onShowAllHolds={openHolds}
          lastSale={lastSale}
          onReprint={reprintLast}
          onReturnItems={() => {
            if (!lastSale) return;
            setReturnsInvoice(lastSale.invoiceNo);
            setMode("returns");
          }}
        />
      )}
    </>
  );

  return (
    <div ref={rootRef} className={tcss.till}>
      {mode === "returns" ? (
        <PosReturnsPanel
          canRefund={hasPermission(permissionKeys, ["sales.refund"])}
          canRefundControlled={hasPermission(permissionKeys, ["sales.approve_controlled"])}
          recentSales={recentSales}
          initialInvoice={returnsInvoice}
          onInitialInvoiceUsed={() => setReturnsInvoice(null)}
          onRefunded={() => void reload()}
          onError={toasts.error}
          onNotice={toasts.success}
          receiptPreferences={receiptPrefs}
          organization={organization}
        >
          {(slots) => (
            <>
              {tillBar(slots.search, slots.recentOpen, slots.toggleRecent)}
              {error && <p className={tcss.notice}>{error}</p>}
              <div className={tcss.body}>{slots.body}</div>
            </>
          )}
        </PosReturnsPanel>
      ) : (
        <>
          {tillBar(
            <PosSearchBar
              products={products}
              onSelect={(product) => addProduct(product)}
              inputRef={searchRef}
              disabled={loading}
              placeholder={
                completedSale && cart.resolved.length === 0
                  ? "Scan the next item to start a new sale"
                  : "Scan a barcode, or type a name, generic or SKU"
              }
            />,
          )}
          {error && <p className={tcss.notice}>{error}</p>}
          <div className={tcss.body}>{saleBody}</div>
        </>
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
            .catch((e: unknown) => toasts.error(e instanceof Error ? e.message : "Could not discard that hold"));
        }}
      />

      <PosLookupModal
        mode={lookupMode}
        products={products}
        onClose={() => setLookupMode(null)}
        onAddManual={(product, qty, unitPrice) => {
          setCompletedSale(null);
          const result = cart.addProduct(product, qty);
          if (result.status === "no-stock") {
            toasts.error(`${product.name} has no sellable stock.`);
            return;
          }
          cart.setUnitPrice(result.key, unitPrice);
          setScannedKey(result.key);
          beep("ok");
          toasts.success(`${product.name} added at ${formatMoney(unitPrice)}.`);
        }}
      />

      <PosShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />

      <PosReceiptModal
        receipt={receipt}
        autoPrint={autoPrintReceipt}
        onClose={() => {
          setReceipt(null);
          setAutoPrintReceipt(false);
        }}
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
            <ModalButton onClick={() => setConfirm(null)}>Keep the sale</ModalButton>
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
