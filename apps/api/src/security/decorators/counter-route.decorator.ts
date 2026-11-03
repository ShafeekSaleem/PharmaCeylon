import { SetMetadata } from "@nestjs/common";

export const COUNTER_ROUTE_KEY = "counterRoute";

/**
 * D-W5: a route a PIN-opened counter login may call. Such a login is limited to the counter it
 * was opened on, so every other route refuses it (`JwtAuthGuard`) — the back office, user and
 * role admin, settings and opening new counter sessions all need an email-and-password login.
 * Mark only the routes the desktop counter app calls; permissions still apply on top.
 */
export const CounterRoute = () => SetMetadata(COUNTER_ROUTE_KEY, true);
