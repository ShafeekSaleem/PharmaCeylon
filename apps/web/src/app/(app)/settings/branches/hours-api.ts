import type { BranchHours, BranchHoursView, HolidaySuggestionsView } from "@pharmaceylon/shared";
import { apiJson } from "@/lib/auth-client";

const base = (branchId: string) => `/tenant/branches/${branchId}/hours`;
const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export function fetchBranchHours(branchId: string): Promise<BranchHoursView> {
  return apiJson<BranchHoursView>(base(branchId));
}

export function fetchHolidaySuggestions(branchId: string): Promise<HolidaySuggestionsView> {
  return apiJson<HolidaySuggestionsView>(`${base(branchId)}/holiday-suggestions`);
}

export function saveBranchHours(
  branchId: string,
  input: { expectedVersion: number; hours: BranchHours; confirmNoSelling?: boolean },
): Promise<BranchHoursView> {
  return apiJson<BranchHoursView>(base(branchId), json("PUT", input));
}

export function approveHoursExtension(
  branchId: string,
  input: { startsAt: string; endsAt: string; reason: string },
): Promise<BranchHoursView> {
  return apiJson<BranchHoursView>(`${base(branchId)}/extensions`, json("POST", input));
}

export function revokeHoursExtension(
  branchId: string,
  extensionId: string,
  reason: string,
): Promise<BranchHoursView> {
  return apiJson<BranchHoursView>(`${base(branchId)}/extensions/${extensionId}/revoke`, json("POST", { reason }));
}
