export const PAGE_SIZE = 10;

export type SupplierType =
  | "distributor"
  | "importer"
  | "manufacturer"
  | "wholesaler"
  | "other";

export type SupplierStatus = "active" | "on_hold" | "inactive";

export type SupplierInvoiceStatus = "open" | "partial" | "paid" | "voided";

export type SupplierStatusFilter = "all" | SupplierStatus;
export type SupplierTypeFilter = "all" | SupplierType;
export type PaymentTermsFilter = "all" | "7" | "14" | "15" | "21" | "30" | "45" | "60";

export type SummaryPeriod = "this_week" | "this_month" | "last_30" | "this_year";

export type SupplierListItem = {
  id: string;
  code: string;
  name: string;
  type: SupplierType;
  status: SupplierStatus;
  isActive: boolean;
  phone: string | null;
  email: string | null;
  contactName: string | null;
  leadTimeDays: number;
  paymentTermsDays: number;
  outstanding: number;
  overdueAmount: number;
  dueLabel: string | null;
  lastOrderAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SupplierInvoice = {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  totalAmount: number;
  paidAmount: number;
  balance: number;
  status: SupplierInvoiceStatus;
  notes: string | null;
  dueLabel: string | null;
  branch: { id: string; code: string; name: string } | null;
  goodsReceipt: { id: string; grnNumber: string } | null;
  createdAt: string;
};

export type SupplierDetail = SupplierListItem & {
  invoices: SupplierInvoice[];
  recentOrders: Array<{
    id: string;
    poNumber: string;
    status: string;
    createdAt: string;
    expectedOn: string | null;
  }>;
};

export type SupplierSummary = {
  totals: {
    supplierCount: number;
    activeCount: number;
    totalPayable: number;
    overduePayable: number;
    ordersThisMonth: number;
  };
  period: {
    key: string;
    label: string;
    orderCount: number;
    purchaseValue: number;
    invoiceCount: number;
    invoiceTotal: number;
  };
  topSuppliers: Array<{
    id: string;
    code: string;
    name: string;
    orderCount: number;
    purchaseValue: number;
  }>;
  recentActivity: Array<{
    id: string;
    kind: "po" | "grn" | "invoice";
    label: string;
    supplierName: string;
    at: string;
    amount?: number;
  }>;
};

export type CreateSupplierPayload = {
  code: string;
  name: string;
  type?: SupplierType;
  status?: SupplierStatus;
  phone?: string;
  email?: string;
  contactName?: string;
  leadTimeDays?: number;
  paymentTermsDays?: number;
};
