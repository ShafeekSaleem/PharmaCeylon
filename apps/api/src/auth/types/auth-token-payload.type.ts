import { RoleName } from "@prisma/client";

export type BranchRolePayload = {
  branchId: string;
  role: RoleName;
};

export type AuthTokenPayload = {
  sub: string;
  tenantId: string;
  email: string;
  branchRoles: BranchRolePayload[];
  type: "access" | "refresh";
};
