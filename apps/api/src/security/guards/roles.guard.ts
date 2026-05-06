import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { RoleName } from "@prisma/client";
import { ROLES_KEY } from "../decorators/roles.decorator";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator";
import { AuthenticatedRequest } from "../interfaces/authenticated-request.interface";

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const requiredRoles = this.reflector.getAllAndOverride<RoleName[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;
    if (!user) {
      throw new ForbiddenException("User context not found");
    }

    const hasOwnerRole = user.branchRoles.some((entry) => entry.role === RoleName.owner);
    if (hasOwnerRole) {
      return true;
    }

    const candidateRoles = request.branchId
      ? user.branchRoles
          .filter((entry) => entry.branchId === request.branchId)
          .map((entry) => entry.role)
      : user.branchRoles.map((entry) => entry.role);

    const allowed = requiredRoles.some((role) => candidateRoles.includes(role));
    if (!allowed) {
      throw new ForbiddenException("Insufficient role");
    }

    return true;
  }
}
