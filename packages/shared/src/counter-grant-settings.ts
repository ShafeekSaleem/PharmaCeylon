import type { BranchHours, BranchHoursExtensionView } from "./branch-hours";
import {
  COUNTER_OFFLINE_RULES,
  type ExternalCardMerchant,
  type OnlinePaymentMethod,
  type RegisterNumbering,
} from "./counter-policy";

/** The two things a prepared local manager may do offline (D8, assisted handover). Each is a
 * role permission, so custom roles work; the grant lists them per prepared staff member. */
export const OFFLINE_MANAGER_PERMISSIONS = Object.freeze({
  acknowledge_business_hours: "sales.offline_hours_acknowledge",
  assist_shift_handover: "sales.offline_handover_assist",
} as const);
export type OfflineManagerAction = keyof typeof OFFLINE_MANAGER_PERMISSIONS;

/**
 * Everything settings contribute to a branch's `OfflineGrant`, read in one place
 * (`GET /tenant/branches/:branchId/counter-settings`). P3 combines it with what settings don't
 * own — the nomination, enrollment, register/till, prepared staff and their credential versions,
 * and the issuing clock — and resolves `hours` into absolute windows for the grant's interval.
 * A grant must be re-issued when either source version changes.
 */
export type CounterGrantSettings = Readonly<{
  branchId: string;
  timezone: string;
  sourceVersions: Readonly<{ counterPolicy: number; operatingHours: number }>;
  fixedRules: typeof COUNTER_OFFLINE_RULES;
  offlineEnabled: boolean;
  /** `OfflineGrant.externalCardAllowed`: true only when offline selling is also enabled. */
  externalCardAllowed: boolean;
  externalCardMerchants: ReadonlyArray<ExternalCardMerchant>;
  onlinePaymentMethods: ReadonlyArray<OnlinePaymentMethod>;
  registerNumbering: ReadonlyArray<RegisterNumbering>;
  /** Null while the branch has no structured hours: no routine window can be signed, so P3
   * must not issue a grant for it. */
  hours: BranchHours | null;
  /** Online-approved business extensions that have not ended or been revoked. */
  extensions: ReadonlyArray<BranchHoursExtensionView>;
  /** Staff who may be a prepared local manager at this branch, and for what. Staff not listed
   * get `offlineManagerActions: []`. */
  offlineManagers: ReadonlyArray<
    Readonly<{ userId: string; name: string; offlineManagerActions: ReadonlyArray<OfflineManagerAction> }>
  >;
}>;
