import { DesktopPosRollout, Prisma } from "@prisma/client";
import {
  effectiveFallbackWindows,
  type FallbackWindow,
  type SaleChannel,
} from "@pharmaceylon/shared";
import type { PosRolloutColumns } from "../tenant/pos-rollout";

type AuditRow = { branchId: string | null; eventName: string; payload: unknown; createdAt: Date };

function endsAt(payload: unknown): Date | null {
  if (!payload || typeof payload !== "object") return null;
  const raw = (payload as { endsAt?: unknown }).endsAt;
  if (typeof raw !== "string") return null;
  const value = new Date(raw);
  return Number.isNaN(value.getTime()) ? null : value;
}

/** Historical fallback intervals from audit, keyed by branch. */
export function fallbackWindowsFromAudit(rows: AuditRow[]): Map<string, FallbackWindow[]> {
  const byBranch = new Map<string, AuditRow[]>();
  for (const row of rows) {
    if (!row.branchId) continue;
    const list = byBranch.get(row.branchId) ?? [];
    list.push(row);
    byBranch.set(row.branchId, list);
  }

  const out = new Map<string, FallbackWindow[]>();
  for (const [branchId, events] of byBranch) {
    const windows: FallbackWindow[] = [];
    let open: { startedAt: Date; endsAt: Date } | null = null;
    for (const event of events.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
      if (event.eventName === "branch.pos_fallback_started") {
        const end = endsAt(event.payload);
        if (!end) continue;
        if (open) {
          const closeAt =
            open.endsAt.getTime() <= event.createdAt.getTime() ? open.endsAt : event.createdAt;
          if (open.startedAt < closeAt) windows.push({ startedAt: open.startedAt, endsAt: closeAt });
        }
        open = { startedAt: event.createdAt, endsAt: end };
      } else if (event.eventName === "branch.pos_fallback_extended") {
        const end = endsAt(event.payload);
        if (!end || !open) continue;
        open.endsAt = end;
      } else if (event.eventName === "branch.pos_fallback_ended" && open) {
        windows.push({ startedAt: open.startedAt, endsAt: event.createdAt });
        open = null;
      }
    }
    if (open) windows.push(open);
    out.set(branchId, windows);
  }
  return out;
}

const WEB_SALE: Prisma.SaleWhereInput = { terminalId: null, offlineCommandId: null };

export type BranchRolloutRow = PosRolloutColumns & { id: string };

function fallbackSoldAtOr(
  branches: readonly BranchRolloutRow[],
  historical: Map<string, FallbackWindow[]>,
): Prisma.SaleWhereInput[] {
  const clauses: Prisma.SaleWhereInput[] = [];
  for (const branch of branches) {
    for (const window of effectiveFallbackWindows(branch, historical.get(branch.id) ?? [])) {
      clauses.push({
        branchId: branch.id,
        soldAt: { gte: window.startedAt, lt: window.endsAt },
      });
    }
  }
  return clauses;
}

function webLegacySoldAtOr(
  branches: readonly BranchRolloutRow[],
  historical: Map<string, FallbackWindow[]>,
): Prisma.SaleWhereInput[] {
  const or: Prisma.SaleWhereInput[] = [];
  for (const branch of branches) {
    if (branch.desktopPosRollout !== DesktopPosRollout.live || !branch.desktopPosLiveAt) {
      or.push({ branchId: branch.id });
      continue;
    }
    or.push({ branchId: branch.id, soldAt: { lt: branch.desktopPosLiveAt } });
    const fallback = fallbackSoldAtOr([branch], historical);
    or.push({
      AND: [
        { branchId: branch.id, soldAt: { gte: branch.desktopPosLiveAt } },
        ...(fallback.length ? [{ NOT: { OR: fallback } }] : []),
      ],
    });
  }
  return or;
}

export function channelWhere(
  channel: SaleChannel,
  branches: readonly BranchRolloutRow[],
  historical: Map<string, FallbackWindow[]>,
): Prisma.SaleWhereInput {
  switch (channel) {
    case "offline":
      return { offlineCommandId: { not: null } };
    case "desktop_online":
      return { terminalId: { not: null }, offlineCommandId: null };
    case "fallback": {
      const ranges = fallbackSoldAtOr(branches, historical);
      return ranges.length
        ? { AND: [WEB_SALE, { OR: ranges }] }
        : { AND: [WEB_SALE, { id: "00000000-0000-4000-8000-000000000000" }] };
    }
    case "web_legacy": {
      const or = webLegacySoldAtOr(branches, historical);
      return or.length ? { AND: [WEB_SALE, { OR: or }] } : { AND: [WEB_SALE] };
    }
    default:
      return {};
  }
}