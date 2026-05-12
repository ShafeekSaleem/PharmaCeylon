import {
  BadRequestException,
  createParamDecorator,
  ExecutionContext,
} from "@nestjs/common";
import { AuthenticatedRequest } from "../interfaces/authenticated-request.interface";

/**
 * Resolves the active branch from `x-branch-id` (set by TenantBranchGuard).
 * Throws if the header was not sent — use on branch-scoped endpoints.
 */
export const RequireBranchId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!req.branchId) {
      throw new BadRequestException("x-branch-id header is required");
    }
    return req.branchId;
  },
);
