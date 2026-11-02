import type {
  OfflineTerminalAssignmentAuthorization,
  OfflineTerminalDelegation,
} from "./terminal-contracts";

/** P1 / revised D13: GET (and every POST) under `/terminals/offline-assignment`, for the
 * selected branch. Times are epoch milliseconds. `nominationVersion` (0 = nothing nominated yet)
 * is what a new authorization must send as `expectedNominationVersion`. */
export type OfflineAssignmentView = Readonly<{
  branchId: string;
  nomination: Readonly<{
    terminalId: string;
    enrollmentId: string;
    version: number;
    activatedAt: number;
  }> | null;
  nominationVersion: number;
  /** Newest first, including revoked ones (`revokedAt` set). */
  delegations: ReadonlyArray<OfflineTerminalDelegation>;
  /** Newest first; at most one has `status: "authorized"`. */
  authorizations: ReadonlyArray<
    OfflineTerminalAssignmentAuthorization &
      Readonly<{
        authority: "owner" | "delegated_manager";
        delegationId: string | null;
        revokedAt: number | null;
        revocationReason: string | null;
        consumedAt: number | null;
      }>
  >;
}>;

/** POST `/terminals/offline-assignment/authorizations`. `authorizationId` is a client-generated
 * UUID: resending the same request is a no-op; reusing it for anything else is a 409. */
export type OfflineAssignmentAuthorizeRequest = Readonly<{
  authorizationId: string;
  targetTerminalId: string;
  targetEnrollmentId: string;
  expectedNominationVersion: number;
  reason: string;
}>;

/** P2 revised D13 activation, step 1: POST `/terminals/offline-assignment/activate/challenge` on the
 * exact target, from the activator's own open staff session there. Returns the
 * `OnlineTerminalCommand<{ authorizationId, expectedNominationVersion }>` to sign verbatim. */
export type OfflineActivationPrepareRequest = Readonly<{
  workSessionId: string;
  authorizationId: string;
  expectedNominationVersion: number;
}>;

/** Step 2: POST `/terminals/offline-assignment/activate` with `{ envelope, attendanceProofId }`. */
export type OfflineActivationResult = Readonly<{
  terminalId: string;
  enrollmentId: string;
  nominationVersion: number;
  activatedAt: number;
  authorizedByUserId: string;
  activatedByUserId: string;
}>;
