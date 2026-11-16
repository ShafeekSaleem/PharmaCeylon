import type { DashboardRole } from "./dashboard-role";
import { isDashboardServerUnreachable } from "./dashboard-connectivity";
import type { DashboardData } from "../hooks/use-dashboard-data";
import { isV6DashboardRole } from "../components/dashboard-fixed-grid";

export function shouldShowV6ServerAlert(
  role: DashboardRole,
  data: Pick<
    DashboardData,
    "branchId" | "loading" | "error" | "failedSections"
  >,
): boolean {
  if (!isV6DashboardRole(role)) return false;
  return isDashboardServerUnreachable(data);
}

export function shouldShowLegacyFailedSectionsAlert(
  role: DashboardRole,
  data: Pick<DashboardData, "branchId" | "failedSections">,
): boolean {
  if (!data.branchId || data.failedSections.size === 0) return false;
  return !isV6DashboardRole(role);
}