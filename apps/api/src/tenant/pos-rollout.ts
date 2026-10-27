import { DesktopPosRollout } from "@prisma/client";

/**
 * The per-branch desktop POS switch (D-W1, D-W7), as every reader sees it.
 *
 * - `not_live`: the branch sells from the web POS exactly as before desktop POS.
 * - `live`: the branch sells from PharmaCeylon POS on its enrolled counters; the web hides POS.
 * - `fallback`: a live branch whose owner has turned the web POS back on until `fallback.endsAt`
 *   because its counters can't sell. It ends on its own at that time, so it is derived from the
 *   clock rather than stored.
 *
 * P1's browser-checkout denial and P7's rollout controls read this same state.
 */
export type PosRolloutState = "not_live" | "live" | "fallback";

export type PosRolloutView = {
  state: PosRolloutState;
  liveSince: string | null;
  fallback: { startedAt: string; endsAt: string } | null;
};

export const POS_ROLLOUT_SELECT = {
  desktopPosRollout: true,
  desktopPosLiveAt: true,
  posFallbackStartedAt: true,
  posFallbackEndsAt: true,
} as const;

export type PosRolloutColumns = {
  desktopPosRollout: DesktopPosRollout;
  desktopPosLiveAt: Date | null;
  posFallbackStartedAt: Date | null;
  posFallbackEndsAt: Date | null;
};

export function fallbackActive(row: PosRolloutColumns, now: Date): boolean {
  return (
    row.desktopPosRollout === DesktopPosRollout.live &&
    row.posFallbackEndsAt != null &&
    row.posFallbackEndsAt.getTime() > now.getTime()
  );
}

export function resolvePosRollout(row: PosRolloutColumns, now: Date = new Date()): PosRolloutView {
  if (row.desktopPosRollout !== DesktopPosRollout.live) {
    return { state: "not_live", liveSince: null, fallback: null };
  }
  const liveSince = row.desktopPosLiveAt?.toISOString() ?? null;
  if (fallbackActive(row, now)) {
    return {
      state: "fallback",
      liveSince,
      fallback: {
        startedAt: row.posFallbackStartedAt!.toISOString(),
        endsAt: row.posFallbackEndsAt!.toISOString(),
      },
    };
  }
  return { state: "live", liveSince, fallback: null };
}

/**
 * A fallback is an exception with an end, not a way back to the web POS for good: an owner who
 * still needs it after this long starts it again, which is audited again.
 */
export const MAX_FALLBACK_HOURS = 7 * 24;

/**
 * The go-live checklist (D-W1). `pending` means the check can't be made until P2's desktop POS
 * records it — nothing in the API knows yet who has prepared a counter or printed a receipt.
 */
export type GoLiveCheckKey = "counter_enrolled" | "staff_prepared" | "test_receipt";
export type GoLiveCheckStatus = "passed" | "missing" | "pending";
export type GoLiveCheck = { key: GoLiveCheckKey; label: string; status: GoLiveCheckStatus };

/**
 * Decided by Shafeek on 2026-10-27: pending checks block going live. Until P2 can confirm them
 * there is no desktop checkout, so a live branch would have nowhere to sell once P1 denies
 * browser checkout for it.
 */
export const PENDING_CHECKS_BLOCK_GO_LIVE = true;

export function goLiveBlocked(checklist: readonly GoLiveCheck[]): boolean {
  return checklist.some(
    (check) =>
      check.status === "missing" || (check.status === "pending" && PENDING_CHECKS_BLOCK_GO_LIVE),
  );
}

export function buildGoLiveChecklist(facts: { activeEnrollments: number }): GoLiveCheck[] {
  return [
    {
      key: "counter_enrolled",
      label: "At least one counter is enrolled",
      status: facts.activeEnrollments > 0 ? "passed" : "missing",
    },
    { key: "staff_prepared", label: "Staff are prepared on a counter", status: "pending" },
    { key: "test_receipt", label: "A test receipt has been printed", status: "pending" },
  ];
}
