import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator";
import { AuthenticatedRequest } from "../interfaces/authenticated-request.interface";

@Injectable()
export class TenantBranchGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;
    if (!user) {
      throw new ForbiddenException("User context not found");
    }

    const branchHeader = request.headers["x-branch-id"];
    const branchId =
      typeof branchHeader === "string"
        ? branchHeader
        : Array.isArray(branchHeader)
          ? branchHeader[0]
          : undefined;

    if (!branchId) {
      return true;
    }

    const hasBranchAccess = user.branchRoles.some((entry) => entry.branchId === branchId);
    if (!hasBranchAccess) {
      throw new ForbiddenException("No access to requested branch");
    }

    request.branchId = branchId;
    return true;
  }
}
