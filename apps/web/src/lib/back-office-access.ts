import type { PosRollout } from "./branch-rollout";

export function isPersonalAccountPath(pathname: string): boolean {
  // The settings home itself is open: it only lists the pages the person may open.
  if (pathname === "/settings") return true;
  return ["/settings/my-profile", "/settings/password-login", "/settings/appearance"].some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
}

export function mayOpenWebPath(
  pathname: string,
  backOfficeAccess: boolean,
  rollout: PosRollout | null,
): boolean {
  if (isPersonalAccountPath(pathname)) return true;
  if (!rollout) return false;
  // Branches keep existing web workflows until desktop go-live.
  if (rollout.state === "not_live") return true;
  if (backOfficeAccess) return true;
  return rollout.state === "fallback" && (pathname === "/pos" || pathname.startsWith("/pos/"));
}
