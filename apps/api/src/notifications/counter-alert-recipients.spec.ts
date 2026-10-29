import { RoleName } from "@prisma/client";
import { defaultCounterAlertPolicy } from "@pharmaceylon/shared";
import {
  counterAlertRecipients,
  counterAlertRule,
  type BranchRoleKey,
} from "./counter-alert-recipients";

const assignments: BranchRoleKey[] = [
  { userId: "manager-here", branchId: "b1", role: RoleName.manager, roleKey: "manager" },
  { userId: "manager-there", branchId: "b2", role: RoleName.manager, roleKey: "manager" },
  { userId: "owner-there", branchId: "b2", role: RoleName.owner, roleKey: "owner" },
  { userId: "cashier-here", branchId: "b1", role: RoleName.cashier, roleKey: null },
  { userId: "lead-here", branchId: "b1", role: RoleName.custom, roleKey: "shift-lead" },
];

describe("counter alert recipients", () => {
  it("uses W7's defaults when nothing is saved: managers at the branch and owners anywhere", () => {
    const rule = counterAlertRule(null, "fallback_changed");
    expect(counterAlertRecipients(rule, assignments, "b1")).toEqual([
      "manager-here",
      "owner-there",
    ]);
  });

  it("follows the saved role keys, custom roles and built-ins without a role row included", () => {
    const policy = defaultCounterAlertPolicy();
    policy.rules = policy.rules.map((rule) =>
      rule.type === "fallback_changed"
        ? { ...rule, recipientRoleKeys: ["cashier", "shift-lead"] }
        : rule,
    );
    const rule = counterAlertRule(policy, "fallback_changed");
    expect(counterAlertRecipients(rule, assignments, "b1")).toEqual([
      "cashier-here",
      "lead-here",
    ]);
    expect(counterAlertRecipients(rule, assignments, "b2")).toEqual([]);
  });

  it("reaches nobody when the alert is switched off", () => {
    const policy = defaultCounterAlertPolicy();
    policy.rules = policy.rules.map((rule) =>
      rule.type === "fallback_changed" ? { ...rule, enabled: false } : rule,
    );
    expect(
      counterAlertRecipients(counterAlertRule(policy, "fallback_changed"), assignments, "b1"),
    ).toEqual([]);
  });

  it("falls back to the defaults rather than silencing alerts when the stored policy is broken", () => {
    const rule = counterAlertRule({ schemaVersion: 9 }, "fallback_changed");
    expect(rule).toEqual({
      type: "fallback_changed",
      enabled: true,
      recipientRoleKeys: ["manager", "owner"],
    });
  });
});
