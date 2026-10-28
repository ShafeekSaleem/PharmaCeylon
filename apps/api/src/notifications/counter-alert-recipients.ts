import { RoleName } from "@prisma/client";
import {
  defaultCounterAlertPolicy,
  parseStoredCounterAlertPolicy,
  type CounterAlertPolicy,
  type CounterAlertRule,
  type CounterAlertType,
} from "@pharmaceylon/shared";

/**
 * Counter alert types W9 can emit today. The rest wait for data that doesn't exist yet:
 * TODO(P2 #48 / P5 #51): counter_offline, snapshot_stale and sync_failed need counter telemetry
 * (heartbeat, stock-snapshot age, sync state); permission_expiring needs P3/P5's offline grants;
 * discrepancy_opened and incident_note need P5/P6's discrepancy cases and incident notes;
 * device_lost needs P2's report-lost / revoke flow. Their settings already exist (W7 #81), and
 * `NotificationsService.notifyCounterAlert` delivers any of them once a source calls it.
 */
export const EMITTED_COUNTER_ALERT_TYPES: readonly CounterAlertType[] = [
  "fallback_changed",
];

/** A stored policy that fails to parse is treated as the default rather than silencing alerts. */
export function counterAlertRule(
  raw: unknown,
  type: CounterAlertType,
): CounterAlertRule {
  const parsed = parseStoredCounterAlertPolicy(raw ?? defaultCounterAlertPolicy());
  const policy: CounterAlertPolicy = parsed.ok
    ? parsed.value
    : defaultCounterAlertPolicy();
  return policy.rules.find((rule) => rule.type === type)!;
}

export type BranchRoleKey = {
  userId: string;
  branchId: string;
  role: RoleName;
  /** `Role.key` of the assignment's role row; built-ins without one use the enum name. */
  roleKey: string | null;
};

/**
 * Who gets a counter alert about one branch: people whose role *at that branch* is a recipient
 * role, plus owners wherever they are (an owner on any branch sees every branch). Role keys,
 * not `RoleName`, so custom roles work. A switched-off alert reaches nobody.
 */
export function counterAlertRecipients(
  rule: CounterAlertRule,
  assignments: readonly BranchRoleKey[],
  branchId: string,
): string[] {
  if (!rule.enabled) return [];
  const keys = new Set(rule.recipientRoleKeys);
  const recipients = new Set<string>();
  for (const entry of assignments) {
    const key = entry.roleKey ?? entry.role;
    if (!keys.has(key)) continue;
    if (entry.branchId === branchId || entry.role === RoleName.owner)
      recipients.add(entry.userId);
  }
  return [...recipients].sort();
}
