export type PermissionRiskLevel = "elevated" | "sensitive";

export type RoleRow = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  isLocked: boolean;
  assignedCount: number;
  permissionKeys: string[];
  /** Catalog defaults for a built-in role (for "Reset to recommended defaults"); null for custom roles. */
  defaultPermissionKeys: string[] | null;
};

export type PermissionDef = {
  key: string;
  label: string;
  description: string;
  riskLevel?: PermissionRiskLevel;
  /** Permission keys this one presupposes — see `permission-catalog.ts` on the API for the source of truth. */
  dependencies?: string[];
};

export type PermissionModule = {
  module: string;
  moduleLabel: string;
  permissions: PermissionDef[];
};

export type CreateRolePayload = {
  name: string;
  description?: string;
  permissionKeys: string[];
};

export type PermissionGrantFilter = "all" | "granted" | "not_granted" | "sensitive";
