export type StocktakeStatus = "draft" | "in_progress" | "completed" | "cancelled";

export type StocktakeStatusFilter =
  | "all"
  | "draft"
  | "in_progress"
  | "completed"
  | "cancelled";

export type StocktakeScope =
  | "full"
  | "cycle"
  | "near_expiry"
  | "quarantined"
  | "zero_stock"
  | "custom";

export type StocktakeLineFilter =
  | "all"
  | "uncounted"
  | "variance"
  | "quarantined"
  | "near_expiry";

export type StocktakeUserRef = {
  id: string;
  fullName: string;
};

export type StocktakeLine = {
  id: string;
  productId: string;
  batchId: string;
  systemQty: number;
  countedQty: number | null;
  varianceQty: number | null;
  note: string | null;
  countedAt: string | null;
  product: { id: string; sku: string; name: string };
  batch: {
    id: string;
    batchNo: string;
    expiryDate: string;
    isQuarantined: boolean;
    costPrice: number;
  };
};

export type StocktakeListItem = {
  id: string;
  stocktakeNumber: string;
  status: StocktakeStatus;
  scope: StocktakeScope;
  blindCount: boolean;
  frozenAt: string | null;
  nearExpiryDays: number | null;
  notes: string | null;
  countedBy: string;
  completedBy: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  counter: StocktakeUserRef;
  completer: StocktakeUserRef | null;
  lines: StocktakeLine[];
  lineCount: number;
  countedLineCount: number;
  uncountedLineCount: number;
  varianceLineCount: number;
  totalSystemQty: number;
  totalCountedQty: number;
  varianceUnitsIn: number;
  varianceUnitsOut: number;
  varianceUnitsNet: number;
  varianceValueApprox: number;
  progressPct: number;
};

export const PAGE_SIZE = 10;

export const WRITE_ROLES = new Set(["owner", "manager", "inventory_clerk"]);
export const COMPLETE_ROLES = new Set(["owner", "manager"]);
