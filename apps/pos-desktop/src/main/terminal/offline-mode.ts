import type { OfflineTerminalState } from "@pharmaceylon/shared";
import type { OfflineModeState } from "../../shared/ipc-contract";
import type { PosDatabase } from "../db/database";
import type { EnrollmentStatus } from "../device/device-store";
import { readInstalledOfflineAuthority } from "./offline-authority";
import { activeOutage } from "./offline-journal";
import type { OfflineJournalWriter } from "./offline-journal-writer";
import { journalNeedsRecovery } from "./reconnect-drain";
import { storeRestoreBlocksOffline } from "./store-restore-sync";
import type { ClockUntrustedReason, TrustedClock } from "./trusted-clock";

/**
 * P4 #50: when the nominated counter sells offline (POS_V1_CONTRACT, "State machine and evidence").
 *
 * - **Connection lost** (`LOST_AFTER_FAILURES` failed checks in a row): only the counter holding a
 *   valid installed offline authority, with trusted time (`TrustedClock`), no journal to recover
 *   and no unacknowledged store restore, enters `offline`. The outage starts at the trusted time
 *   of the first failed check, and the 15-minute stock check is made against that start
 *   (`ensureOfflineOutageSession`). Any other disconnected counter is `stopped`: it makes no
 *   operational writes until it is back online.
 * - **One outage per loss.** Connection flaps and app restarts resume the same outage, its start,
 *   its stock baseline and its grant expiry; nothing here starts a new timer on an outage
 *   already recorded. The 24-hour grant expiry still ends offline selling (`stopped`).
 * - **Reconnected**: once the connection has held for `RECONNECT_STABLE_CHECKS` checks, an outage
 *   is `draining` (D12): P5's journal sync uploads, resolves and installs a fresh pair, which ends
 *   the outage. From then on that outage never sells offline again, a dropped connection or a
 *   restart included (`outage_reconnect`): the counter waits for the drain to finish.
 * - **Restart** (decision of 2026-11-17): an app restart in the same Windows session resumes; after
 *   a Windows restart or power cut there is no trusted time (`NEW_BOOT`) until the counter is
 *   online again, so the outage stays `stopped`. Saved sales stay saved either way.
 *
 * Everything is read from this computer's encrypted store and its own connection checks, never
 * from the renderer.
 */

/** How often the counter checks it can reach the server. */
export const CONNECTION_CHECK_MS = 5_000;
/** Failed checks in a row before the connection counts as lost (about 10 s). */
export const LOST_AFTER_FAILURES = 2;
/** Successful checks in a row before a reconnect counts as stable (about 15 s). */
export const RECONNECT_STABLE_CHECKS = 3;

export type OfflineMode = "online" | "draining" | "offline" | "stopped";

/** Why a disconnected counter can't sell offline. */
export type OfflineStopReason =
  | "NOT_ENROLLED"
  | "TERMINAL_REVOKED"
  /** Not the branch's offline counter, or it has no offline authority installed. */
  | "NO_OFFLINE_AUTHORITY"
  /** Saved stock was more than 15 minutes old when the connection was lost. */
  | "SNAPSHOT_STALE"
  | "GRANT_EXPIRED"
  /** No trusted time: Windows restarted, or no signed server time has been received. */
  | "CLOCK_UNTRUSTED"
  /** A journal to recover or a store restore to acknowledge, online first. */
  | "RECONCILIATION_REQUIRED"
  /** The outage's reconnect began its synchronisation; it finishes online. */
  | "SYNC_PAUSED";

export type OfflineModeView = {
  mode: OfflineMode;
  /** The shared contract's state, for the offline sale and shift policy checks. */
  terminalState: OfflineTerminalState;
  reason: OfflineStopReason | null;
  /** Why trusted time is missing, when `reason` is `CLOCK_UNTRUSTED`. */
  clock: ClockUntrustedReason | null;
  connected: boolean;
  outage: { offlineSessionId: string; offlineStartedAt: number } | null;
  grantExpiresAt: number | null;
  snapshotGeneratedAt: number | null;
  /** Trusted time when this was worked out, if there is any. */
  trustedNow: number | null;
};

export type OfflineModeDeps = {
  db: PosDatabase;
  clock: Pick<TrustedClock, "now" | "stamp">;
  journal: Pick<OfflineJournalWriter, "ensureOfflineOutageSession">;
  readDevice: () => {
    identity: { enrollmentId: string };
    status: EnrollmentStatus;
  } | null;
  /** One unauthenticated check that the server answers. Never throws. */
  probe: () => Promise<boolean>;
  /** A change of mode, for the log. */
  report?: (view: OfflineModeView, previous: OfflineMode | null) => void;
  wallMs?: () => number;
};

const OUTAGE_START_ERRORS: Record<string, OfflineStopReason> = {
  NO_OFFLINE_AUTHORITY: "NO_OFFLINE_AUTHORITY",
  SNAPSHOT_STALE: "SNAPSHOT_STALE",
  GRANT_EXPIRED: "GRANT_EXPIRED",
  RECONCILIATION_REQUIRED: "RECONCILIATION_REQUIRED",
};

function reconnectedOutage(
  db: PosDatabase,
  enrollmentId: string,
): string | null {
  const row = db
    .prepare(
      "SELECT offline_session_id FROM outage_reconnect WHERE enrollment_id = ?",
    )
    .get(enrollmentId) as { offline_session_id: string } | undefined;
  return row?.offline_session_id ?? null;
}

export function createOfflineMode(deps: OfflineModeDeps) {
  const wall = deps.wallMs ?? Date.now;
  /**
   * Unknown at start: treated as connected until the checks say otherwise, so a restart never
   * starts an outage by itself. An outage recorded before the restart shows as draining
   * meanwhile, which sells nothing; it is only marked reconnected once a reconnect holds.
   */
  let connected = true;
  let failures = 0;
  let successes = 0;
  /** Trusted time of the first failed check in the current run of failures. */
  let firstFailureAt: number | null = null;
  let inFlight = false;
  let last: OfflineMode | null = null;

  function base(
    enrollmentId: string | null,
  ): Omit<OfflineModeView, "mode" | "terminalState" | "reason" | "clock"> {
    const installed = enrollmentId
      ? readInstalledOfflineAuthority(deps.db, enrollmentId)
      : null;
    const reading = deps.clock.now();
    return {
      connected,
      outage: enrollmentId ? activeOutage(deps.db, enrollmentId) : null,
      grantExpiresAt: installed?.grant.payload.expiresAt ?? null,
      snapshotGeneratedAt: installed?.snapshot.payload.generatedAt ?? null,
      trustedNow: reading.trusted ? reading.nowMs : null,
    };
  }

  function stopped(
    view: ReturnType<typeof base>,
    reason: OfflineStopReason,
    terminalState: OfflineTerminalState,
    clock: ClockUntrustedReason | null = null,
  ): OfflineModeView {
    return { ...view, mode: "stopped", terminalState, reason, clock };
  }

  /** Where the counter stands now, from local state. Starts an outage when one is due. */
  function evaluate(): OfflineModeView {
    const device = deps.readDevice();
    const enrollmentId =
      device && device.status !== "pending"
        ? device.identity.enrollmentId
        : null;
    const view = base(enrollmentId);
    if (!device || !enrollmentId) {
      return connected
        ? {
            ...view,
            mode: "online",
            terminalState: "nominated",
            reason: null,
            clock: null,
          }
        : stopped(view, "NOT_ENROLLED", "nominated");
    }
    const revoked = device.status === "revoked" || device.status === "retired";
    const outage = view.outage;
    const installed = view.grantExpiresAt !== null;

    if (connected) {
      if (outage)
        return {
          ...view,
          mode: "draining",
          terminalState: revoked ? "revoked" : "draining",
          reason: null,
          clock: null,
        };
      return {
        ...view,
        mode: "online",
        terminalState: revoked ? "revoked" : installed ? "ready" : "nominated",
        reason: null,
        clock: null,
      };
    }

    if (revoked) return stopped(view, "TERMINAL_REVOKED", "revoked");
    if (
      outage &&
      reconnectedOutage(deps.db, enrollmentId) === outage.offlineSessionId
    )
      return stopped(view, "SYNC_PAUSED", "draining");
    if (
      storeRestoreBlocksOffline(deps.db, enrollmentId) ||
      (!outage && journalNeedsRecovery(deps.db, enrollmentId))
    )
      return stopped(
        view,
        "RECONCILIATION_REQUIRED",
        outage ? "draining" : "nominated",
      );
    if (!installed)
      return stopped(
        view,
        "NO_OFFLINE_AUTHORITY",
        outage ? "draining" : "nominated",
      );
    const reading = deps.clock.now();
    if (!reading.trusted)
      return stopped(
        view,
        "CLOCK_UNTRUSTED",
        outage ? "draining" : "ready",
        reading.reason,
      );
    if (reading.nowMs >= view.grantExpiresAt!)
      return stopped(view, "GRANT_EXPIRED", outage ? "draining" : "nominated");

    if (outage)
      return {
        ...view,
        mode: "offline",
        terminalState: "offline",
        reason: null,
        clock: null,
      };

    // A new outage, from the first failed check: record its start once, as trusted time.
    const stamp = deps.clock.stamp();
    if (!stamp.trusted)
      return stopped(view, "CLOCK_UNTRUSTED", "ready", stamp.reason);
    const startedAt = Math.min(firstFailureAt ?? stamp.nowMs, stamp.nowMs);
    try {
      const started = deps.journal.ensureOfflineOutageSession(
        enrollmentId,
        startedAt,
      );
      return {
        ...view,
        outage: started,
        trustedNow: stamp.nowMs,
        mode: "offline",
        terminalState: "offline",
        reason: null,
        clock: null,
      };
    } catch (error) {
      const code =
        error instanceof Error ? OUTAGE_START_ERRORS[error.message] : undefined;
      if (!code) throw error;
      return stopped(
        view,
        code,
        code === "SNAPSHOT_STALE" || code === "GRANT_EXPIRED"
          ? "nominated"
          : "ready",
      );
    }
  }

  function settle(): OfflineModeView {
    const view = evaluate();
    if (view.mode !== last) {
      deps.report?.(view, last);
      last = view.mode;
    }
    return view;
  }

  /** A stable reconnect during an outage: from now on it drains, and never sells offline again. */
  function markReconnected(): void {
    const device = deps.readDevice();
    if (!device || device.status === "pending") return;
    const enrollmentId = device.identity.enrollmentId;
    const outage = activeOutage(deps.db, enrollmentId);
    if (!outage) return;
    deps.db
      .prepare(
        `INSERT INTO outage_reconnect (enrollment_id, offline_session_id, reconnected_at) VALUES (?, ?, ?)
         ON CONFLICT (enrollment_id) DO UPDATE SET offline_session_id = excluded.offline_session_id,
           reconnected_at = excluded.reconnected_at
         WHERE outage_reconnect.offline_session_id <> excluded.offline_session_id`,
      )
      .run(
        enrollmentId,
        outage.offlineSessionId,
        new Date(wall()).toISOString(),
      );
  }

  return {
    /** One connection check and what follows from it. Never throws. */
    async tick(): Promise<OfflineModeView> {
      if (inFlight) return settle();
      inFlight = true;
      try {
        const reachable = await deps.probe().catch(() => false);
        if (reachable) {
          failures = 0;
          firstFailureAt = null;
          successes += 1;
          // Back online only once it holds; an outage drains only then, after a restart too.
          if (successes >= RECONNECT_STABLE_CHECKS) {
            connected = true;
            markReconnected();
          }
        } else {
          successes = 0;
          if (failures === 0) {
            const reading = deps.clock.now();
            firstFailureAt = reading.trusted ? reading.nowMs : null;
          }
          failures += 1;
          if (failures >= LOST_AFTER_FAILURES) connected = false;
        }
        return settle();
      } finally {
        inFlight = false;
      }
    },
    /** Where the counter stands now, without a connection check. */
    view(): OfflineModeView {
      return settle();
    },
  };
}

export type OfflineModeService = ReturnType<typeof createOfflineMode>;

const iso = (ms: number | null) =>
  ms === null ? null : new Date(ms).toISOString();

/** The renderer's view: plain fields and ISO times. Before startup finishes: online, nothing known. */
export function offlineModeForRenderer(
  view: OfflineModeView | null,
): OfflineModeState {
  if (!view)
    return {
      mode: "online",
      reason: null,
      clock: null,
      connected: true,
      outageStartedAt: null,
      grantExpiresAt: null,
      snapshotGeneratedAt: null,
    };
  return {
    mode: view.mode,
    reason: view.reason,
    clock: view.clock,
    connected: view.connected,
    outageStartedAt: iso(view.outage?.offlineStartedAt ?? null),
    grantExpiresAt: iso(view.grantExpiresAt),
    snapshotGeneratedAt: iso(view.snapshotGeneratedAt),
  };
}

/** Starts the connection checks on a timer. */
export function startOfflineMode(
  deps: OfflineModeDeps & { onError: (error: unknown) => void },
): {
  mode: OfflineModeService;
  stop: () => void;
} {
  const mode = createOfflineMode(deps);
  const run = () => void mode.tick().catch(deps.onError);
  const timer = setInterval(run, CONNECTION_CHECK_MS);
  timer.unref();
  run();
  return { mode, stop: () => clearInterval(timer) };
}
