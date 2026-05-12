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

export interface AuthenticatedRequest extends Request {
  user?: RequestUser;
  branchId?: string;
  cookies?: Record<string, string>;
}
