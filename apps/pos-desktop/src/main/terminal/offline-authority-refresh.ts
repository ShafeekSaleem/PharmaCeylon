import { randomUUID, type KeyObject } from "node:crypto";
import type { OnlineTerminalCommand } from "@pharmaceylon/shared";
import { ApiError, type ApiSession } from "../api/api-client";
import type { PosDatabase } from "../db/database";
import {
  installOfflineAuthority,
  readInstalledOfflineAuthority,
  type InstallResult,
  type OfflineAuthority,
} from "./offline-authority";
import { activeOutage, journalCoverage, localJournalHead } from "./offline-journal";
import { readAcceptedWatermark } from "./reconnect-drain";
import type { TerminalService } from "./terminal-service";

const operation = "POST /api/v1/terminals/offline-authority";

/** How often the counter checks; most checks end locally (fresh enough, or backing off). */
export const OFFLINE_AUTHORITY_TICK_MS = 60_000;
/**
 * Renew once the installed snapshot is this old. An outage may only start on a snapshot at most
 * 15 minutes old, so a healthy counter's saved stock is 5–6 minutes old at worst. That leaves
 * room for a failed renewal and its 1- and 2-minute retries (5 + 1 + 2 + request time) before
 * the snapshot is too old, without a renewal every minute. Each renewal also restarts the 24
 * hours of the grant.
 */
export const OFFLINE_AUTHORITY_REFRESH_MS = 5 * 60_000;
/** A counter that isn't the branch's offline counter asks again this much later. */
export const NOT_NOMINATED_RECHECK_MS = 15 * 60_000;
export const FIRST_BACKOFF_MS = 60_000;
/** Back-off cap for a failure that may clear by itself (network, server busy): the cadence. */
const TRANSIENT_BACKOFF_CAP_MS = OFFLINE_AUTHORITY_REFRESH_MS;
/** Back-off cap for one that needs a person (setup, reconciliation, a pair that won't verify). */
const PERSISTENT_BACKOFF_CAP_MS = 30 * 60_000;

/** Server refusals that won't clear until someone changes something. */
const PERSISTENT_CODES = new Set(["GRANT_INVALID", "BRANCH_HOURS_NOT_CONFIGURED", "RECONCILIATION_REQUIRED"]);

export class OfflineAuthorityInstallError extends Error {
  constructor(readonly result: Exclude<InstallResult, "installed" | "already_installed">) {
    super(`Offline authority not installed: ${result}`);
    this.name = "OfflineAuthorityInstallError";
  }
}

/** What the readiness checks show about renewal. In memory: a restart starts it afresh. */
export type OfflineAuthorityRefreshStatus = {
  /** False once the server said this isn't the branch's offline counter; null until it answers. */
  nominated: boolean | null;
  lastSuccessAt: number | null;
  consecutiveFailures: number;
  /** An API error code, an install result (`invalid`, `local_usage` …), or `NETWORK`. */
  lastFailure: { at: number; code: string } | null;
  nextAttemptAt: number | null;
};

export type OfflineAuthorityRefreshDeps = {
  db: PosDatabase;
  api: Pick<ApiSession, "request">;
  terminal: Pick<TerminalService, "current" | "attendCommand">;
  readDevice: () => { registerId: string; tillId: string } | null;
  signer: { keyId: string; publicKey: KeyObject };
  report: (error: unknown) => void;
  now?: () => number;
  /** An extra local-use veto for the installer (tests); the installer checks the journal itself. */
  localUsage?: (db: PosDatabase, enrollmentId: string) => boolean;
};

function failureCode(error: unknown): string {
  if (error instanceof OfflineAuthorityInstallError) return error.result;
  if (error instanceof ApiError) return error.status === 0 ? "NETWORK" : error.code;
  return "NETWORK";
}

function persistent(error: unknown): boolean {
  if (error instanceof OfflineAuthorityInstallError) return true;
  return error instanceof ApiError && PERSISTENT_CODES.has(error.code);
}

/**
 * Keeps this counter's offline authority fresh while it is online (P3 #49): installs the first
 * pair, then renews it every five minutes through the rebasing installer.
 *
 * Every renewal is a new signed command with its own attendance proof. The proof is taken
 * automatically (console session, no remote-control tools), so it costs a process listing and a
 * request, not a person's time. It is what ties each fresh 24 hours of authority to this
 * computer being used at the counter now: reusing an old proof would let a remote session keep
 * renewing indefinitely.
 */
export function createOfflineAuthorityRefresh(deps: OfflineAuthorityRefreshDeps) {
  const now = deps.now ?? Date.now;
  const localUsage = deps.localUsage;
  let inFlight = false;
  const status: OfflineAuthorityRefreshStatus = {
    nominated: null, lastSuccessAt: null, consecutiveFailures: 0, lastFailure: null, nextAttemptAt: null,
  };

  function due(enrollmentId: string): boolean {
    const installed = readInstalledOfflineAuthority(deps.db, enrollmentId);
    if (!installed || now() - installed.snapshot.payload.generatedAt >= OFFLINE_AUTHORITY_REFRESH_MS) return true;
    // P5 #51: a drain waits for a pair rebased over the journal, and an installed pair that
    // doesn't include the journal is stale however young it is.
    const { includedThroughSequence: sequence, includedThroughHash: hash } = installed.snapshot.payload;
    return activeOutage(deps.db, enrollmentId) !== null ||
      journalCoverage(deps.db, enrollmentId, { sequence, hash }) !== "covered";
  }

  /** P5 #51: journal entries recorded here that the server has not confirmed accepting. A pair
   * issued now could not include them, so asking for one would only mint a version this counter
   * refuses to install: the journal upload goes first. */
  function journalWaiting(enrollmentId: string): boolean {
    return readAcceptedWatermark(deps.db, enrollmentId).sequence < localJournalHead(deps.db, enrollmentId).sequence;
  }

  /** One request ID per pending request, kept across restarts until its response arrives, so a
   * lost response is recovered by replay instead of minting another version. */
  function requestIdFor(enrollmentId: string): string {
    deps.db.prepare(`
      INSERT INTO offline_authority_request (enrollment_id, request_id)
      VALUES (?, ?) ON CONFLICT(enrollment_id) DO NOTHING
    `).run(enrollmentId, randomUUID());
    return (deps.db.prepare("SELECT request_id FROM offline_authority_request WHERE enrollment_id = ?")
      .get(enrollmentId) as { request_id: string }).request_id;
  }

  async function attempt(): Promise<"installed" | "skipped"> {
    const current = deps.terminal.current();
    const device = deps.readDevice();
    if (!current || !device) return "skipped";
    const { identity, key, staff } = current;
    if (!due(identity.enrollmentId)) return "skipped";
    if (journalWaiting(identity.enrollmentId)) throw new OfflineAuthorityInstallError("local_usage");
    const requestId = requestIdFor(identity.enrollmentId);
    const branchId = identity.branchId;
    const command = await deps.api.request<OnlineTerminalCommand<{ requestId: string }>>(
      "POST", "/terminals/offline-authority/challenge", {
        branchId, body: { workSessionId: staff.workSessionId, requestId },
      },
    );
    if (command.operation !== operation || command.body.requestId !== requestId ||
        Object.keys(command.body).length !== 1 ||
        Object.keys(identity).some((field) => command.identity[field as keyof typeof identity] !== identity[field as keyof typeof identity]) ||
        command.session.registerId !== device.registerId || command.session.tillId !== device.tillId ||
        command.session.staffUserId !== staff.staffUserId || command.session.workSessionId !== staff.workSessionId)
      throw new Error("Unexpected offline authority challenge");
    const proof = await deps.terminal.attendCommand(command);
    const response = await deps.api.request<OfflineAuthority>("POST", "/terminals/offline-authority", {
      branchId, body: { envelope: key.sign(command, "command"), attendanceProofId: proof.proofId },
    });
    // Someone else signed in meanwhile: the server kept the pair, and the next tick replays it.
    if (deps.terminal.current()?.staff.workSessionId !== staff.workSessionId) return "skipped";
    const result = installOfflineAuthority(deps.db, response, {
      identity, registerId: device.registerId, tillId: device.tillId, signer: deps.signer, trustedNow: now(),
    }, localUsage);
    // The response arrived, so this request is settled whatever the install made of it; the next
    // renewal is a new request. (A replay of a pair that is now too old would never verify.)
    deps.db.prepare("DELETE FROM offline_authority_request WHERE enrollment_id = ? AND request_id = ?")
      .run(identity.enrollmentId, requestId);
    if (result !== "installed" && result !== "already_installed") throw new OfflineAuthorityInstallError(result);
    return "installed";
  }

  return {
    /** One check. Never throws: failures are reported and delay the next attempt. */
    async tick(): Promise<void> {
      if (inFlight || (status.nextAttemptAt !== null && now() < status.nextAttemptAt)) return;
      inFlight = true;
      try {
        if ((await attempt()) === "installed") {
          status.nominated = true;
          status.lastSuccessAt = now();
          status.consecutiveFailures = 0;
          status.lastFailure = null;
        }
        status.nextAttemptAt = null;
      } catch (error) {
        if (error instanceof ApiError && error.code === "IDENTITY_MISMATCH") {
          // Not (or no longer) the branch's offline counter: nothing is wrong, check again later.
          status.nominated = false;
          status.consecutiveFailures = 0;
          status.lastFailure = null;
          status.nextAttemptAt = now() + NOT_NOMINATED_RECHECK_MS;
          return;
        }
        status.consecutiveFailures += 1;
        status.lastFailure = { at: now(), code: failureCode(error) };
        const cap = persistent(error) ? PERSISTENT_BACKOFF_CAP_MS : TRANSIENT_BACKOFF_CAP_MS;
        status.nextAttemptAt = now() + Math.min(cap, FIRST_BACKOFF_MS * 2 ** (status.consecutiveFailures - 1));
        deps.report(error);
      } finally {
        inFlight = false;
      }
    },
    /**
     * Try again at the next tick whatever the back-off (P5 #51): the journal has just been
     * accepted and a drain waits for a fresh pair. A renewal is due then anyway (`due`).
     */
    renewNow(): void {
      status.nextAttemptAt = null;
    },
    status(): OfflineAuthorityRefreshStatus {
      return { ...status, lastFailure: status.lastFailure && { ...status.lastFailure } };
    },
  };
}

export type OfflineAuthorityRefresh = ReturnType<typeof createOfflineAuthorityRefresh>;

/** Starts the check on a timer; returns the refresh (for its status) and the stop. */
export function startOfflineAuthorityRefresh(deps: OfflineAuthorityRefreshDeps): {
  refresh: OfflineAuthorityRefresh;
  stop: () => void;
} {
  const refresh = createOfflineAuthorityRefresh(deps);
  const timer = setInterval(() => void refresh.tick(), OFFLINE_AUTHORITY_TICK_MS);
  timer.unref();
  return { refresh, stop: () => clearInterval(timer) };
}
