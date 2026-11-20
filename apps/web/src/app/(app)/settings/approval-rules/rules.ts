import type { TenantSettings } from "../lib/tenant-settings";

/**
 * The rules the Approval Rules page shows, in its order. The settings home counts how many are
 * on from this same list, so adding a rule here changes both.
 */
export type ApprovalRuleKey =
  | "controlled"
  | "purchaseOrders"
  | "transfers"
  | "refunds"
  | "writeOffs";

export type ApprovalRule = {
  key: ApprovalRuleKey;
  label: string;
  /** Enforced by the API and cannot be switched off. */
  locked?: boolean;
  isOn: (settings: TenantSettings) => boolean;
};

export const APPROVAL_RULES: ApprovalRule[] = [
  { key: "controlled", label: "Controlled substance sales", locked: true, isOn: () => true },
  {
    key: "purchaseOrders",
    label: "Purchase orders over a threshold",
    isOn: (s) => s.approvalRequiredPurchaseOrderThreshold != null,
  },
  {
    key: "transfers",
    label: "Branch stock transfers",
    isOn: (s) => s.approvalRequiredForBranchTransfers,
  },
  {
    key: "refunds",
    label: "Refunds over a threshold",
    isOn: (s) => s.approvalRequiredReturnThreshold != null,
  },
  {
    key: "writeOffs",
    label: "Write-offs over a threshold",
    isOn: (s) => s.approvalRequiredWriteOffThreshold != null,
  },
];

export function approvalRuleLabel(key: ApprovalRuleKey): string {
  return APPROVAL_RULES.find((rule) => rule.key === key)?.label ?? key;
}
