import type { TerminalEnrollmentOfflineBackup } from "@pharmaceylon/shared";

type NominationSlice = Readonly<{
  enrollmentId: string;
  activatedAt: Date;
  activatedByUserId: string;
  authorizationId: string;
}>;

type AuthorizationSlice = Readonly<{
  authorizedAt: Date;
  authorizedByUserId: string;
}>;

/** Maps branch offline rows to counter-visible backup facts for one enrollment. */
export function buildEnrollmentOfflineBackup(
  enrollmentId: string,
  nomination: NominationSlice | null,
  nominationAuthorization: AuthorizationSlice | null,
  outstandingAuthorization: AuthorizationSlice | null,
  fullName: (userId: string) => string | null,
): TerminalEnrollmentOfflineBackup {
  const none: TerminalEnrollmentOfflineBackup = {
    authorizedAt: null,
    authorizedByUserId: null,
    authorizedByFullName: null,
    activatedAt: null,
    activatedByUserId: null,
    activatedByFullName: null,
  };
  if (!nomination && !outstandingAuthorization) return none;

  const isNominated = nomination?.enrollmentId === enrollmentId;
  if (isNominated && nomination) {
    const auth = nominationAuthorization;
    return {
      authorizedAt: auth ? auth.authorizedAt.getTime() : null,
      authorizedByUserId: auth?.authorizedByUserId ?? null,
      authorizedByFullName: auth ? fullName(auth.authorizedByUserId) : null,
      activatedAt: nomination.activatedAt.getTime(),
      activatedByUserId: nomination.activatedByUserId,
      activatedByFullName: fullName(nomination.activatedByUserId),
    };
  }

  if (outstandingAuthorization) {
    return {
      authorizedAt: outstandingAuthorization.authorizedAt.getTime(),
      authorizedByUserId: outstandingAuthorization.authorizedByUserId,
      authorizedByFullName: fullName(outstandingAuthorization.authorizedByUserId),
      activatedAt: null,
      activatedByUserId: null,
      activatedByFullName: null,
    };
  }

  return none;
}
