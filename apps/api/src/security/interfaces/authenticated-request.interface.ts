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
  branchRoles: BranchRole[];
};

export interface AuthenticatedRequest extends Request {
  user?: RequestUser;
  branchId?: string;
}
