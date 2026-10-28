/** W7 settings for counter alerts: which alert types are sent, and to which roles. W9 #71
 * generates and delivers the alerts; this is only who gets them. */
export const COUNTER_ALERT_TYPES = [
  "counter_offline",
  "permission_expiring",
  "snapshot_stale",
  "sync_failed",
  "discrepancy_opened",
  "incident_note",
  "device_lost",
  "fallback_changed",
] as const;
export type CounterAlertType = (typeof COUNTER_ALERT_TYPES)[number];

export const COUNTER_ALERT_LABELS: Readonly<Record<CounterAlertType, { label: string; hint: string }>> = {
  counter_offline: { label: "Counter offline", hint: "A counter has lost its connection." },
  permission_expiring: {
    label: "Offline permission expiring",
    hint: "An offline counter's 24-hour permission is about to end.",
  },
  snapshot_stale: {
    label: "Stock update stale",
    hint: "A counter's last stock update is too old to start selling offline.",
  },
  sync_failed: { label: "Sync paused or failed", hint: "A counter can't upload its sales." },
  discrepancy_opened: {
    label: "Discrepancy case opened",
    hint: "Offline sales don't match stock or cash and need review.",
  },
  incident_note: { label: "Incident note", hint: "Staff recorded a note against a sale." },
  device_lost: { label: "Device reported lost", hint: "A counter was reported lost or revoked." },
  fallback_changed: {
    label: "Fallback started or ending",
    hint: "Web checkout fallback started at a branch, or is about to end.",
  },
};

export const MAX_ALERT_RECIPIENT_ROLES = 20;

export type CounterAlertRule = {
  type: CounterAlertType;
  enabled: boolean;
  /** `Role.key`: a built-in role name or a custom role's slug, so custom roles work. */
  recipientRoleKeys: string[];
};
export type CounterAlertPolicy = { schemaVersion: 1; rules: CounterAlertRule[] };
export type CounterAlertPolicyView = { version: number; policy: CounterAlertPolicy };

export function defaultCounterAlertPolicy(): CounterAlertPolicy {
  return {
    schemaVersion: 1,
    rules: COUNTER_ALERT_TYPES.map((type) => ({
      type,
      enabled: true,
      recipientRoleKeys: ["manager", "owner"],
    })),
  };
}

const ROLE_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** One rule per type, in catalogue order. A switched-on alert needs at least one recipient role;
 * which role keys exist in the tenant is left to the server. */
export function validateCounterAlertPolicy(
  input: unknown,
): { ok: true; value: CounterAlertPolicy } | { ok: false; message: string } {
  const fail = (message: string) => ({ ok: false as const, message });
  if (!input || typeof input !== "object" || Array.isArray(input))
    return fail("Counter alert settings must be an object.");
  const doc = input as Record<string, unknown>;
  if (Object.keys(doc).some((key) => !["schemaVersion", "rules"].includes(key)))
    return fail("Counter alert settings contain unknown fields.");
  if (doc.schemaVersion !== 1 || !Array.isArray(doc.rules))
    return fail("Counter alert settings need version 1 and a list of rules.");
  const byType = new Map<CounterAlertType, CounterAlertRule>();
  for (const raw of doc.rules) {
    if (
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      Object.keys(raw).some((key) => !["type", "enabled", "recipientRoleKeys"].includes(key))
    )
      return fail("Each alert rule needs only its type, switch and recipient roles.");
    const { type, enabled, recipientRoleKeys } = raw as Record<string, unknown>;
    if (!(COUNTER_ALERT_TYPES as readonly unknown[]).includes(type))
      return fail("Unknown counter alert type.");
    if (byType.has(type as CounterAlertType)) return fail("An alert type is listed twice.");
    if (typeof enabled !== "boolean") return fail("Each alert needs an explicit on/off switch.");
    if (
      !Array.isArray(recipientRoleKeys) ||
      recipientRoleKeys.length > MAX_ALERT_RECIPIENT_ROLES ||
      recipientRoleKeys.some((key) => typeof key !== "string" || !ROLE_KEY.test(key)) ||
      new Set(recipientRoleKeys).size !== recipientRoleKeys.length
    )
      return fail("Recipients must be a list of distinct roles.");
    if (enabled && recipientRoleKeys.length === 0)
      return fail(`Choose who gets "${COUNTER_ALERT_LABELS[type as CounterAlertType].label}", or switch it off.`);
    byType.set(type as CounterAlertType, {
      type: type as CounterAlertType,
      enabled,
      recipientRoleKeys: [...(recipientRoleKeys as string[])].sort(),
    });
  }
  if (byType.size !== COUNTER_ALERT_TYPES.length) return fail("Every counter alert type needs a rule.");
  return {
    ok: true,
    value: { schemaVersion: 1, rules: COUNTER_ALERT_TYPES.map((type) => byType.get(type)!) },
  };
}
