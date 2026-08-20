import { SetMetadata } from "@nestjs/common";

export const PERMISSION_KEY = "permissions";

/**
 * Gates an endpoint behind one or more permission keys (OR semantics — the
 * caller needs any one of them, mirroring the old `@Roles(...)` behavior).
 * Checked by `RolesGuard`, which still short-circuits for the `owner` role
 * before ever consulting permissions — see `security/guards/roles.guard.ts`.
 */
export const RequirePermission = (...keys: string[]) => SetMetadata(PERMISSION_KEY, keys);
