export type PosMode = "retail" | "prescription" | "returns";

export type PaymentMethod = "cash" | "card" | "mobile_wallet";

export type PosBatch = {
  id: string;
  batchNo: string;
  expiryDate: string;
  sellingPrice: string;
  costPrice: string;
  qtyOnHand: number;
  daysToExpiry: number;
  nearExpiry: boolean;
};

export type PosProduct = {
  id: string;
  sku: string;
  name: string;
  barcode: string | null;
  genericName: string | null;
  brandName: string | null;
  dosageForm: string | null;
  strength: string | null;
  unit: string | null;
  packSize: string | null;
  imageUrl: string | null;
  isControlled: boolean;
  /** Needs a linked Rx (antibiotics etc.). Controlled always implies this. */
  requiresPrescription: boolean;
  reorderLevel: number;
  qtyOnHand: number;
  stockStatus: "ok" | "low" | "out";
  /** FEFO order — soonest expiry first. */
  batches: PosBatch[];
  units30d: number;
  lines90d: number;
  /** Primary COMMERCIAL category — powers the Category quick-add tab, not Dosage Form. */
  commercialCategoryId: string | null;
  commercialCategoryName: string | null;
  commercialDepartmentId: string | null;
};

export type PosDepartment = { id: string; name: string; canonicalKey: string | null };

export type PosCatalog = {
  vatRatePercent: number;
  nearExpiryDays: number;
  products: PosProduct[];
  /** Active COMMERCIAL departments for this tenant — never shows a department nobody enabled. */
  departments: PosDepartment[];
};

export type CartLine = {
  /** Stable React key; a product+batch pair is coalesced rather than duplicated. */
  key: string;
  productId: string;
  batchId: string;
  qty: number;
  unitPrice: number;
  discountPercent: number;
  addedAt: number;
};

/** A cart line joined with the catalog rows it points at. */
export type ResolvedCartLine = CartLine & {
  product: PosProduct;
  batch: PosBatch;
  gross: number;
  discountAmount: number;
  taxAmount: number;
  lineTotal: number;
  overStock: boolean;
};

export type CartTotals = {
  itemCount: number;
  unitCount: number;
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  grandTotal: number;
};

export type Customer = {
  id: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
};

export type Prescription = {
  id: string;
  rxNumber: string;
  patientName: string;
  doctorName: string;
  doctorRegNo: string | null;
  issuedOn: string;
  validUntil: string | null;
  notes: string | null;
  customerId: string | null;
  createdAt: string;
  customer: { id: string; fullName: string; phone: string | null } | null;
};

export type HoldReason = "awaiting_pharmacist" | "parked";

export type HeldSaleSummary = {
  id: string;
  holdRef: string;
  label: string | null;
  itemCount: number;
  total: string;
  createdAt: string;
  heldByName: string;
  needsPharmacist?: boolean;
  holdReason?: string | null;
};

export type HeldSalePayload = {
  lines: CartLine[];
  meta: {
    mode?: PosMode;
    customerId?: string | null;
    prescriptionId?: string | null;
    notes?: string | null;
    holdReason?: HoldReason | null;
    needsPharmacist?: boolean;
  };
};

export type HeldSaleDetail = {
  id: string;
  holdRef: string;
  label: string | null;
  itemCount: number;
  total: string;
  createdAt: string;
  payload: HeldSalePayload;
};

export type RecentSale = {
  id: string;
  invoiceNo: string;
  status: "posted" | "voided" | "refunded" | "partially_refunded";
  soldAt: string;
  grandTotal: string;
  itemCount: number;
  customerName: string | null;
  sellerName: string;
  productIds: string[];
  summary: string;
};

export type SalePaymentRecord = {
  id: string;
  method: PaymentMethod;
  amount: string;
  reference: string | null;
};

export type SaleReceipt = {
  id: string;
  invoiceNo: string;
  status: "posted" | "voided" | "refunded" | "partially_refunded";
  soldAt: string;
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  grandTotal: string;
  amountPaid: string;
  changeDue: string;
  notes: string | null;
  customer: { id: string; fullName: string; phone: string | null } | null;
  prescription: {
    id: string;
    rxNumber: string;
    patientName: string;
    doctorName: string;
  } | null;
  seller: { id: string; fullName: string };
  dispenser: { id: string; fullName: string } | null;
  payments: SalePaymentRecord[];
  items: {
    id: string;
    qty: number;
    unitPrice: string;
    discountAmount: string;
    taxAmount: string;
    lineTotal: string;
    product: { id: string; name: string; sku: string; unit: string | null };
    batch: { id: string; batchNo: string; expiryDate: string };
  }[];
};

export type AlertSeverity = "danger" | "warning" | "info";

export type PosAlertActionKind = "link_rx" | "pharmacist_pin" | "hold_pharmacist";

export type PosAlert = {
  id: string;
  severity: AlertSeverity;
  title: string;
  detail: string;
  count: number;
  /** Set when the alert must be cleared before the sale can post. */
  blocking?: boolean;
  /** Counter CTAs — keep the till moving instead of a dead-end block. */
  actions?: { kind: PosAlertActionKind; label: string }[];
};

export type PosApprover = {
  id: string;
  fullName: string;
  email: string;
  hasPosPin: boolean;
  roles: string[];
};

export type PharmacistApproval = {
  approverUserId: string;
  pin: string;
};

export type TenderLine = {
  method: PaymentMethod;
  amount: string;
  reference?: string;
};

export type CheckoutPayload = {
  items: {
    productId: string;
    batchId: string;
    qty: number;
    unitPrice: string;
    discountAmount: string;
  }[];
  customerId?: string;
  prescriptionId?: string;
  notes?: string;
  payments?: TenderLine[];
  heldSaleId?: string;
  pharmacistApproval?: PharmacistApproval;
};
