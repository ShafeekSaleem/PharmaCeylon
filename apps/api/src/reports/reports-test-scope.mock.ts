import { Prisma } from "@prisma/client";
import type { SalesReportScopeService } from "./sales-report-scope.service";

const placeholderSaleShape = () => ({
  id: "00000000-0000-4000-8000-000000000001",
  soldAt: new Date("2025-06-01T12:00:00.000Z"),
  grandTotal: new Prisma.Decimal(0),
  discountTotal: new Prisma.Decimal(0),
  status: "posted" as "posted" | "partially_refunded",
  terminalId: null,
  tillId: null,
  shiftId: null,
  offlineCommandId: null,
  stockPosting: "posted" as const,
  branchId: "branch-1",
  branch: {
    id: "branch-1",
    desktopPosRollout: "not_live" as const,
    desktopPosLiveAt: null,
    posFallbackStartedAt: null,
    posFallbackEndsAt: null,
  },
  shift: null,
});

/** Keeps legacy ReportsService unit tests on Prisma mocks without a database. */
export function mockSalesReportScope(
  sales: ReturnType<typeof placeholderSaleShape>[] = [],
): SalesReportScopeService {
  const openWindow = {
    days: 30,
    timeZone: "Asia/Colombo",
    since: new Date(0),
    before: new Date("2099-01-01T00:00:00.000Z"),
    paddedSince: new Date(0),
    paddedBefore: new Date("2099-01-01T00:00:00.000Z"),
  };
  return {
    reportWindow: jest.fn().mockResolvedValue(openWindow),
    loadPostedSales: jest.fn().mockResolvedValue({
      sales,
      occurredAtByCommandId: new Map(),
    }),
    freshness: jest.fn().mockResolvedValue({
      generatedAt: new Date().toISOString(),
      latestSyncedAt: null,
      pendingOfflineCount: 0,
    }),
    breakdown: jest.fn().mockResolvedValue([]),
    saleWhereForReports: jest.fn().mockResolvedValue({ tenantId: "tenant-1" }),
    inEffectiveWindow: jest.fn().mockReturnValue(true),
    businessDateKey: jest.fn().mockReturnValue("2025-06-01"),
    weekdayIndex: jest.fn().mockReturnValue(0),
    hourOfDay: jest.fn().mockReturnValue(12),
    occurredAtByCommandId: jest.fn().mockResolvedValue(new Map()),
    filterPostedSalesInWindow: jest.fn().mockImplementation((rows: unknown[]) => Promise.resolve(rows)),
    openDiscrepancySaleIds: jest.fn().mockResolvedValue(new Set()),
    deriveOfflineSyncState: jest.fn().mockReturnValue(null),
    resolveTimeZone: jest.fn().mockResolvedValue("Asia/Colombo"),
  } as unknown as SalesReportScopeService;
}