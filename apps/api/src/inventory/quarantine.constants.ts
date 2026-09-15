/**
 * Reason recorded when a batch is quarantined because it expired, rather than by a
 * pharmacist typing one in. `quarantineExpired` writes it, and the seed reuses it so demo
 * data reads exactly as the app's own auto-quarantine would have written it — the reason on
 * a batch always comes from the quarantine step that set it, never from a bespoke string at
 * the call site.
 */
export const AUTO_QUARANTINE_EXPIRED_REASON = "Auto-quarantined: expired";
