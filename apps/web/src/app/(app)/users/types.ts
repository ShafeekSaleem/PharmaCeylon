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

/** `status` describes the registration only; the clinical check also needs an active account. */
export type PharmacistRegistrationStatus = "current" | "expired" | "revoked";

/** P1 #47: an owner-recorded SLMC registration (`GET /admin/pharmacist-registrations`). */
export type PharmacistRegistration = {
  id: string;
  userId: string;
  fullName: string;
  email: string;
  accountActive: boolean;
  slmcNumber: string;
  /** YYYY-MM-DD, the last day it is current, in the tenant's timezone. */
  expiresOn: string;
  status: PharmacistRegistrationStatus;
  recordedByUserId: string;
  recordedAt: string;
  revokedAt: string | null;
  revokedByUserId: string | null;
  revocationReason: string | null;
};

export type SecurityInfo = {
  pin: {
    isSet: boolean;
    isLocked: boolean;
    lockedUntil: string | null;
    /** Too many wrong PINs: off until they sign in with their password, or it is reset. */
    switchedOff: boolean;
    failedAttempts: number;
    version: number;
  };
  preparedCounters: PreparedCounter[];
  sessions: SessionInfo[];
};
