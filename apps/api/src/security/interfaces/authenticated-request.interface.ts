import { Request } from "express";
import { RoleName } from "@prisma/client";

export type BranchRole = {
  branchId: string;
  role: RoleName;
};

export type RequestUser = {
  userId: string;
  tenantId: string;
  email: string;
  fullName: string;
  branchRoles: BranchRole[];
  /** "cookie" for browser flows, "bearer" for mobile/scripts. Used by CsrfGuard. */
  authMethod: "cookie" | "bearer";
};

/** Omit `cookies` so we can keep it optional before `cookie-parser` runs. */
export interface AuthenticatedRequest extends Omit<Request, "cookies"> {
  user?: RequestUser;
  branchId?: string;
  cookies?: Record<string, string>;
}
