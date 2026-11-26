import { BadRequestException } from "@nestjs/common";
import {
  OFFLINE_SALE_SYNC_STATES,
  SALE_CHANNELS,
  type OfflineSaleSyncState,
  type SaleChannel,
} from "@pharmaceylon/shared";

export type SalesReportGroupBy = "terminal" | "shift" | "channel";

const GROUP_BY_VALUES: SalesReportGroupBy[] = ["terminal", "shift", "channel"];

export type SalesReportFilters = Readonly<{
  terminalId?: string;
  registerId?: string;
  shiftId?: string;
  channel?: SaleChannel;
  offlineSyncState?: OfflineSaleSyncState;
}>;

export type SalesReportQuery = Readonly<{
  filters: SalesReportFilters;
  groupBy?: SalesReportGroupBy;
}>;

export const EMPTY_SALES_REPORT_QUERY: SalesReportQuery = { filters: {} };

/** Longest window a sales report may ask for: two years, so a one-year range still fits its
 *  previous-period comparison (the web fetches `days * 2`). */
export const SALES_REPORT_MAX_DAYS = 731;

/** `days` from the query string: a whole number from 1 to `SALES_REPORT_MAX_DAYS`, or `fallback`
 *  when it is missing or not a positive number. */
export function parseReportDays(raw: string | undefined, fallback = 30): number {
  const n = Number(raw);
  if (!raw || !Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), SALES_REPORT_MAX_DAYS);
}

export function salesReportFiltersActive(filters: SalesReportFilters): boolean {
  return Boolean(
    filters.terminalId ||
      filters.registerId ||
      filters.shiftId ||
      filters.channel ||
      filters.offlineSyncState,
  );
}

export function parseSalesReportQuery(
  query: Record<string, string | undefined>,
): SalesReportQuery {
  const filters: {
    terminalId?: string;
    registerId?: string;
    shiftId?: string;
    channel?: SaleChannel;
    offlineSyncState?: OfflineSaleSyncState;
  } = {};

  const terminalId = query.terminalId?.trim();
  if (terminalId) filters.terminalId = terminalId;

  const registerId = query.registerId?.trim();
  if (registerId) filters.registerId = registerId;

  const shiftId = query.shiftId?.trim();
  if (shiftId) filters.shiftId = shiftId;

  const channelRaw = query.channel?.trim();
  if (channelRaw) {
    if (!(SALE_CHANNELS as readonly string[]).includes(channelRaw)) {
      throw new BadRequestException(
        `channel must be one of: ${SALE_CHANNELS.join(", ")}`,
      );
    }
    filters.channel = channelRaw as SaleChannel;
  }

  const syncRaw = query.offlineSyncState?.trim();
  if (syncRaw) {
    if (!(OFFLINE_SALE_SYNC_STATES as readonly string[]).includes(syncRaw)) {
      throw new BadRequestException(
        `offlineSyncState must be one of: ${OFFLINE_SALE_SYNC_STATES.join(", ")}`,
      );
    }
    filters.offlineSyncState = syncRaw as OfflineSaleSyncState;
  }

  const groupByRaw = query.reportGroupBy?.trim();
  let groupBy: SalesReportGroupBy | undefined;
  if (groupByRaw) {
    if (!GROUP_BY_VALUES.includes(groupByRaw as SalesReportGroupBy)) {
      throw new BadRequestException(`reportGroupBy must be one of: ${GROUP_BY_VALUES.join(", ")}`);
    }
    groupBy = groupByRaw as SalesReportGroupBy;
  }

  return { filters, groupBy };
}