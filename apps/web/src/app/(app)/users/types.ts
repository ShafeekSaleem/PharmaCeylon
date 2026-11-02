import type { RoleName } from "@/lib/role-access";

export type BranchRoleMapping = {
  id: string;
  branchId: string;
  role: RoleName;
  roleId?: string | null;
  /** Present when `role` resolves via a Role row (built-in or custom) — carries the live display name. */
  roleRef?: { id: string; name: string; key: string } | null;
};

export type AdminUser = {
  id: string;
  email: string;
  fullName: string;
  isActive: boolean;
  createdAt: string;
  userBranchRoles: BranchRoleMapping[];
};

export type CreateStaffPayload = {
  email: string;
  fullName: string;
};

export type StaffInvitation = {
  id: string;
  email: string;
  fullName: string;
  expiresAt: string;
  createdAt: string;
  roles: Array<{
    branchId: string;
    role: RoleName;
    roleId?: string | null;
    branch: { name: string; code: string };
    roleRef?: { name: string } | null;
  }>;
};

export type AssignRolePayload = {
  branchId: string;
  role: RoleName;
  /** Required when `role` is `"custom"` — the tenant's custom Role id to grant. */
  roleId?: string;
};

export type UpdateStaffPayload = {
  fullName?: string;
  isActive?: boolean;
};

export type RoleFilter = "all" | RoleName;
export type StatusFilter = "all" | "active" | "inactive";
export type BranchFilter = "all" | string;

export type SessionInfo = {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  lastUsedAt: string | null;
  createdAt: string;
};

/** A counter the person entered their PIN on while online (D-W5). Stale after a PIN change. */
export type PreparedCounter = {
  terminalId: string;
  branchId: string;
  branchName: string;
  counterLabel: string;
  preparedAt: string;
  pinVersion: number;
  current: boolean;
};

export type SecurityInfo = {
  pin: {
    isSet: boolean;
    isLocked: boolean;
    lockedUntil: string | null;
    failedAttempts: number;
    version: number;
  };
  preparedCounters: PreparedCounter[];
  sessions: SessionInfo[];
};
