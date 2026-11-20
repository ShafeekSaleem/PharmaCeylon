import type { OfflineAssignmentView } from "@pharmaceylon/shared";
import { apiJson } from "@/lib/auth-client";
import type { AdminUser } from "../../users/types";
import type { RoleRow } from "../../users/roles/types";

// Pin the branch on every request, including retries after an auth refresh.
export function delegationsApi(branchId: string) {
  const headers = { "x-branch-id": branchId };
  const post = (path: string, body: unknown) =>
    apiJson<OfflineAssignmentView>(`/terminals/offline-assignment/${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  return {
    view: () =>
      apiJson<OfflineAssignmentView>("/terminals/offline-assignment", {
        headers,
      }),
    staff: () => apiJson<AdminUser[]>("/admin/users", { headers }),
    roles: () => apiJson<RoleRow[]>("/admin/roles", { headers }),
    grant: (managerUserId: string) => post("delegations", { managerUserId }),
    revoke: (delegationId: string, reason: string) =>
      post(`delegations/${delegationId}/revoke`, { reason }),
  };
}

/** A custom role with branch management is eligible too; the server rechecks live authority. */
export function eligibleManagers(
  staff: AdminUser[],
  roles: RoleRow[],
  branchId: string,
) {
  return staff.filter(
    (person) =>
      person.isActive &&
      !person.userBranchRoles.some((r) => r.role === "owner") &&
      person.userBranchRoles.some((r) => {
        if (r.branchId !== branchId) return false;
        const role = r.roleRef
          ? roles.find((role) => role.id === r.roleRef!.id)
          : roles.find((role) => role.key === r.role);
        // Legacy unlinked built-in assignments use catalog defaults, as AccessService does.
        const permissions = r.roleRef
          ? role?.permissionKeys
          : role?.defaultPermissionKeys;
        return permissions?.includes("tenant.management") === true;
      }),
  );
}
