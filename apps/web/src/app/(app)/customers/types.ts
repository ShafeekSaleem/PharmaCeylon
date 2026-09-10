export const PAGE_SIZE = 25;

export type CustomerStatusFilter = "all" | "active" | "inactive";

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

export type CustomerListItem = Customer & {
  _count: { sales: number; prescriptions: number };
};

export type CustomerListResponse = {
  items: CustomerListItem[];
  total: number;
  page: number;
  pageSize: number;
};

export type CustomerSale = {
  id: string;
  invoiceNo: string;
  status: string;
  soldAt: string;
  grandTotal: string;
  branch: { name: string };
  prescription: { id: string; rxNumber: string } | null;
  _count: { items: number };
};

export type CustomerPrescription = {
  id: string;
  rxNumber: string;
  patientName: string;
  doctorName: string;
  issuedOn: string;
  validUntil: string | null;
  branch: { name: string };
};

export type CustomerProfile = {
  customer: Customer;
  sales: CustomerSale[];
  prescriptions: CustomerPrescription[];
  stats: {
    postedSaleCount: number;
    lifetimeValue: string;
    lastPurchaseAt: string | null;
  };
};

export type CustomerFormValues = {
  fullName: string;
  phone: string;
  email: string;
  address: string;
  notes: string;
};
