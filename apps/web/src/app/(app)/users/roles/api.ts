import { apiJson } from "@/lib/auth-client";
import type { CreateRolePayload, PermissionModule, RoleRow } from "./types";

export function fetchRoles(): Promise<RoleRow[]> {
  return apiJson<RoleRow[]>("/admin/roles");
}

export function fetchPermissionCatalog(): Promise<PermissionModule[]> {
  return apiJson<PermissionModule[]>("/admin/roles/permissions");
}

export function createRole(payload: CreateRolePayload): Promise<RoleRow> {
  return apiJson<RoleRow>("/admin/roles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function updateRole(
  roleId: string,
  payload: { name?: string; description?: string },
): Promise<{ id: string; name: string; description: string | null }> {
  return apiJson(`/admin/roles/${roleId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function updateRolePermissions(
  roleId: string,
  permissionKeys: string[],
): Promise<{ id: string; permissionKeys: string[] }> {
  return apiJson(`/admin/roles/${roleId}/permissions`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ permissionKeys }),
  });
}

export function deleteRole(roleId: string): Promise<{ ok: boolean }> {
  return apiJson(`/admin/roles/${roleId}`, { method: "DELETE" });
}
