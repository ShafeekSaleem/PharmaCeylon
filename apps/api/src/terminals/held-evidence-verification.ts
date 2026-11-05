import type {
  OfflineBusinessHoursAcknowledgement,
  OfflineGrant,
  OfflineStaffAuthorization,
  OfflineStaffSignIn,
  TerminalIdentity,
} from "@pharmaceylon/shared";
import { invalid, object, parseIdentity, parseSession, uuid } from "./terminal-wire";

/**
 * P3 #49: the grant-side checks for held offline evidence, as pure functions over a grant this
 * server issued (`offline_authority_issuance`) and the journal evidence P5 sync supplies.
 *
 * Every refusal names one reason. Checks run in a fixed order so the same evidence always gets
 * the same reason: grant, sign-in, staff, credential, capability, outage, window, mandatory.
 */
export const HELD_EVIDENCE_REFUSALS = [
  /** No grant with this ID was issued to this exact enrollment (unknown, or another counter's). */
  "grant_not_issued",
  /** The grant exists but the record names another version, nomination or device identity. */
  "grant_binding_mismatch",
  /** The sign-in is not the one the record cites, or not for this grant, device or counter. */
  "sign_in_mismatch",
  /** The record's work session is not the session the cited sign-in opened. */
  "work_session_mismatch",
  /** The person is not in the grant's `authorizedStaff` (not prepared on this counter then). */
  "staff_not_prepared",
  /** The sign-in used another preparation or PIN version than the grant authorized. */
  "credential_version_mismatch",
  /** The manager was prepared but the grant did not give them `acknowledge_business_hours`. */
  "manager_lacks_capability",
  /** The acknowledgement is not bound to the outage the evidence describes. */
  "outage_mismatch",
  /** Something happened before the grant began or after it expired. */
  "outside_grant_window",
  /** The acknowledged time is outside the grant's mandatory windows, which nothing overrides. */
  "mandatory_window_overridden",
] as const;
export type HeldEvidenceRefusal = (typeof HELD_EVIDENCE_REFUSALS)[number];

/** The original outage, from the signed journal command that relies on the acknowledgement. */
export type OutageEvidence = Readonly<{ offlineSessionId: string; offlineStartedAt: number }>;

const IDENTITY_KEYS: ReadonlyArray<keyof TerminalIdentity> = [
  "tenantId",
  "branchId",
  "terminalId",
  "enrollmentId",
  "keyId",
];
const sameIdentity = (a: TerminalIdentity, b: TerminalIdentity) =>
  IDENTITY_KEYS.every((key) => a[key] === b[key]);
const safe = (value: unknown, minimum = 0): number => {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) invalid();
  return value as number;
};

/** Strict exact-key parser for the shared `OfflineStaffSignIn` attestation P5 hands over. */
export function parseStaffSignIn(raw: unknown): OfflineStaffSignIn {
  const p = object(raw, [
    "contractVersion",
    "kind",
    "staffSignInId",
    "identity",
    "session",
    "grantId",
    "grantVersion",
    "staffAuthorizationId",
    "credentialVersion",
    "method",
    "authenticatedAt",
  ]);
  if (p.contractVersion !== 1 || p.kind !== "offline_staff_sign_in" || p.method !== "personal_pin")
    invalid();
  for (const key of ["staffSignInId", "grantId", "staffAuthorizationId"] as const) uuid(p[key]);
  parseIdentity(p.identity);
  parseSession(p.session);
  safe(p.grantVersion, 1);
  safe(p.credentialVersion, 1);
  safe(p.authenticatedAt);
  return p as OfflineStaffSignIn;
}

/** Strict parser for the outage evidence. */
export function parseOutage(raw: unknown): OutageEvidence {
  const p = object(raw, ["offlineSessionId", "offlineStartedAt"]);
  uuid(p.offlineSessionId);
  safe(p.offlineStartedAt);
  return p as OutageEvidence;
}

/** Whether [startsAt, endsAt) lies wholly inside the union of `windows`. */
export function coveredBy(
  windows: ReadonlyArray<Readonly<{ startsAt: number; endsAt: number }>>,
  startsAt: number,
  endsAt: number,
): boolean {
  let cursor = startsAt;
  const sorted = [...windows].sort((a, b) => a.startsAt - b.startsAt);
  for (const w of sorted) {
    if (cursor >= endsAt) break;
    if (w.startsAt > cursor) return false;
    if (w.endsAt > cursor) cursor = w.endsAt;
  }
  return cursor >= endsAt;
}

type StaffCheck = { staff: OfflineStaffAuthorization } | { refusal: HeldEvidenceRefusal };

/**
 * The sign-in a record cites: for this grant on this exact device and counter, by someone the
 * grant authorized, with the same preparation and PIN version, before the record and within the
 * grant's lifetime.
 */
function signInRefusal(
  grant: OfflineGrant,
  signIn: OfflineStaffSignIn,
  citedSignInId: string,
  recordedAt: number,
): StaffCheck {
  if (
    signIn.staffSignInId !== citedSignInId ||
    !sameIdentity(signIn.identity, grant.identity) ||
    signIn.grantId !== grant.grantId ||
    signIn.grantVersion !== grant.grantVersion ||
    signIn.session.registerId !== grant.registerId ||
    signIn.session.tillId !== grant.tillId
  )
    return { refusal: "sign_in_mismatch" };
  const staff = grant.authorizedStaff.find((s) => s.staffUserId === signIn.session.staffUserId);
  if (!staff) return { refusal: "staff_not_prepared" };
  if (
    signIn.staffAuthorizationId !== staff.staffAuthorizationId ||
    signIn.credentialVersion !== staff.credentialVersion ||
    signIn.method !== staff.signInMethod
  )
    return { refusal: "credential_version_mismatch" };
  if (
    signIn.authenticatedAt < grant.notBefore ||
    signIn.authenticatedAt >= grant.expiresAt ||
    signIn.authenticatedAt > recordedAt ||
    recordedAt < grant.notBefore ||
    recordedAt >= grant.expiresAt
  )
    return { refusal: "outside_grant_window" };
  return { staff };
}

/**
 * Revised D8 against the issued grant (#49 acceptance): the acknowledgement binds that grant's
 * exact version, nomination and device, and the original outage; the acknowledging manager is
 * in its `authorizedStaff` with `acknowledge_business_hours` and the same credential version;
 * the window stays inside the grant's lifetime; mandatory windows are never overridden.
 *
 * `grant` is null when this enrollment was never issued a grant with the cited ID.
 */
export function hoursAcknowledgementRefusal(
  grant: OfflineGrant | null,
  ack: OfflineBusinessHoursAcknowledgement,
  managerSignIn: OfflineStaffSignIn,
  outage: OutageEvidence,
): HeldEvidenceRefusal | null {
  if (!grant || grant.grantId !== ack.grantId) return "grant_not_issued";
  if (
    !sameIdentity(ack.identity, grant.identity) ||
    ack.grantVersion !== grant.grantVersion ||
    ack.nominationVersion !== grant.nominationVersion
  )
    return "grant_binding_mismatch";
  const signIn = signInRefusal(grant, managerSignIn, ack.managerSignInId, ack.recordedAt);
  if ("refusal" in signIn) return signIn.refusal;
  if (!signIn.staff.offlineManagerActions.includes("acknowledge_business_hours"))
    return "manager_lacks_capability";
  if (
    outage.offlineSessionId !== ack.offlineSessionId ||
    outage.offlineStartedAt < grant.notBefore ||
    outage.offlineStartedAt >= grant.expiresAt ||
    outage.offlineStartedAt > ack.recordedAt
  )
    return "outage_mismatch";
  if (ack.startsAt < grant.notBefore || ack.endsAt > grant.expiresAt) return "outside_grant_window";
  if (
    grant.mandatoryOperatingWindows !== null &&
    !coveredBy(grant.mandatoryOperatingWindows, ack.startsAt, ack.endsAt)
  )
    return "mandatory_window_overridden";
  return null;
}

/** The grant-side facts of a held sale-incident note or card-attempt event. */
export type SupportRecordFacts = Readonly<{
  identity: TerminalIdentity;
  staffSignInId: string;
  workSessionId: string;
  recordedAt: number;
  /** Other offline staff the record names (incident recorder, card-decline verifier). */
  namedStaffUserIds: readonly string[];
}>;

/**
 * Support records cite a sign-in, which cites a grant. The sign-in must belong to an issued grant
 * of this enrollment and to the record's work session; everyone the record names must be staff
 * that grant authorized. Passing this verifies authority only: sale, shift and card-machine
 * evidence stays P5's, so the record stays held.
 */
export function supportRecordRefusal(
  grant: OfflineGrant | null,
  record: SupportRecordFacts,
  staffSignIn: OfflineStaffSignIn,
): HeldEvidenceRefusal | null {
  if (!grant || grant.grantId !== staffSignIn.grantId) return "grant_not_issued";
  if (!sameIdentity(record.identity, grant.identity)) return "grant_binding_mismatch";
  const signIn = signInRefusal(grant, staffSignIn, record.staffSignInId, record.recordedAt);
  if ("refusal" in signIn) return signIn.refusal;
  if (staffSignIn.session.workSessionId !== record.workSessionId) return "work_session_mismatch";
  const authorized = new Set(grant.authorizedStaff.map((s) => s.staffUserId));
  if (record.namedStaffUserIds.some((id) => !authorized.has(id))) return "staff_not_prepared";
  return null;
}
