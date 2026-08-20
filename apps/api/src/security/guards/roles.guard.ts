import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { RoleName } from "@prisma/client";
import { PERMISSION_KEY } from "../decorators/require-permission.decorator";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator";
import { AuthenticatedRequest } from "../interfaces/authenticated-request.interface";
import { PermissionsService } from "../permissions.service";

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: PermissionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;
    if (!user) {
      throw new ForbiddenException("User context not found");
    }

    // Hardcoded, non-configurable: owner on ANY branch always passes. This
    // safety check is intentionally independent of the permission system so
    // a tenant can never edit its way into locking out every owner.
    const hasOwnerRole = user.branchRoles.some((entry) => entry.role === RoleName.owner);
    if (hasOwnerRole) {
      return true;
    }

    const candidates = request.branchId
      ? user.branchRoles.filter((entry) => entry.branchId === request.branchId)
      : user.branchRoles;

    const allowed = await this.permissions.hasAnyPermission(candidates, requiredPermissions);
    if (!allowed) {
      throw new ForbiddenException("Insufficient permissions");
    }

    return true;
  }
}
