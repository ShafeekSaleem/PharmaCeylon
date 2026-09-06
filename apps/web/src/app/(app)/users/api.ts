import { apiJson, type TenantBranch } from "@/lib/auth-client";
import type { SecurityInfo, StaffInvitation } from "./types";

/**
 * All active tenant branches, unscoped by the caller's own branch roles —
 * unlike `fetchTenantBranches()` (`/tenant/branches`), which only returns
 * branches the caller personally has a role on. This admin page needs the
 * full tenant picture so a manager can see/manage staff on branches they
 * don't personally cover.
 */
export function fetchAdminBranches(): Promise<TenantBranch[]> {
  return apiJson<TenantBranch[]>("/admin/users/branches");
}

export function fetchStaffSecurity(userId: string): Promise<SecurityInfo> {
  return apiJson<SecurityInfo>(`/admin/users/${userId}/security`);
}

export function resetStaffPin(userId: string): Promise<{ reset: boolean }> {
  return apiJson(`/admin/users/${userId}/reset-pin`, { method: "POST" });
}

export function forceStaffLogout(userId: string): Promise<{ ok: boolean }> {
  return apiJson(`/admin/users/${userId}/force-logout`, { method: "POST" });
}

export function fetchStaffInvitations(): Promise<StaffInvitation[]> {
  return apiJson<StaffInvitation[]>("/admin/users/invitations");
}

export function createStaffInvitation(input: {
  email: string;
  fullName: string;
  assignments: Array<{ branchId: string; role: string; roleId?: string }>;
}): Promise<{ id: string; expiresAt: string }> {
  return apiJson("/admin/users/invitations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function resendStaffInvitation(id: string) {
  return apiJson<{ ok: true; expiresAt: string }>(`/admin/users/invitations/${id}/resend`, {
    method: "POST",
  });
}

export function revokeStaffInvitation(id: string) {
  return apiJson<{ ok: true }>(`/admin/users/invitations/${id}`, { method: "DELETE" });
}
