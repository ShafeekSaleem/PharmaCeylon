import { randomUUID, type KeyObject } from "node:crypto";
import type { OnlineTerminalCommand } from "@pharmaceylon/shared";
import { ApiError, type ApiSession } from "../api/api-client";
import type { PosDatabase } from "../db/database";
import { installInitialOfflineAuthority, type OfflineAuthority } from "./offline-authority";
import type { TerminalService } from "./terminal-service";

const operation = "POST /api/v1/terminals/offline-authority";

/** How often the counter checks; most checks end locally (installed, or waiting out a back-off). */
export const OFFLINE_AUTHORITY_TICK_MS = 60_000;
/** A counter that isn't the branch's offline counter asks again this much later. */
export const NOT_NOMINATED_RECHECK_MS = 15 * 60_000;
/** Back-off after any other failure: 1, 2, 4 … minutes, at most 30. */
const FIRST_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;

export type OfflineAuthorityRefreshDeps = {
  db: PosDatabase;
  api: Pick<ApiSession, "request">;
  terminal: Pick<TerminalService, "current" | "attendCommand">;
  readDevice: () => { registerId: string; tillId: string } | null;
  signer: { keyId: string; publicKey: KeyObject };
  report: (error: unknown) => void;
  now?: () => number;
};

/**
 * Installs this counter's first offline authority (P3 #49) while it is online. Each request costs
 * the server a challenge and the counter an attendance proof, so a counter that isn't the
 * branch's offline counter, or keeps failing, asks less often instead of every minute.
 */
export function createOfflineAuthorityRefresh(deps: OfflineAuthorityRefreshDeps) {
  const now = deps.now ?? Date.now;
  let inFlight = false;
  let failures = 0;
  let nextAttemptAt = 0;

  async function attempt(): Promise<"installed" | "skipped"> {
    const current = deps.terminal.current();
    const device = deps.readDevice();
    if (!current || !device) return "skipped";
    const { identity, key, staff } = current;
    if (deps.db.prepare("SELECT 1 FROM offline_authority WHERE enrollment_id = ?").get(identity.enrollmentId))
      return "skipped";
    // One request ID per enrollment, kept across restarts, so a lost response is recovered by
    // replay instead of being refused as a second issuance.
    deps.db.prepare(`
      INSERT INTO offline_authority_request (enrollment_id, request_id)
      VALUES (?, ?) ON CONFLICT(enrollment_id) DO NOTHING
    `).run(identity.enrollmentId, randomUUID());
    const { request_id: requestId } = deps.db.prepare(`
      SELECT request_id FROM offline_authority_request WHERE enrollment_id = ?
    `).get(identity.enrollmentId) as { request_id: string };
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
    const result = installInitialOfflineAuthority(deps.db, response, {
      identity, registerId: device.registerId, tillId: device.tillId, signer: deps.signer, trustedNow: now(),
    });
    if (result !== "installed" && result !== "already_installed")
      throw new Error(`Offline authority not installed: ${result}`);
    return "installed";
  }

  return {
    /** One check. Never throws: failures are reported and delay the next attempt. */
    async tick(): Promise<void> {
      if (inFlight || now() < nextAttemptAt) return;
      inFlight = true;
      try {
        await attempt();
        failures = 0;
        nextAttemptAt = 0;
      } catch (error) {
        if (error instanceof ApiError && error.code === "IDENTITY_MISMATCH") {
          // Not (or no longer) the branch's offline counter: nothing is wrong, check again later.
          failures = 0;
          nextAttemptAt = now() + NOT_NOMINATED_RECHECK_MS;
          return;
        }
        failures += 1;
        nextAttemptAt = now() + Math.min(MAX_BACKOFF_MS, FIRST_BACKOFF_MS * 2 ** (failures - 1));
        deps.report(error);
      } finally {
        inFlight = false;
      }
    },
  };
}

/** Starts the check on a timer; returns the stop. */
export function startOfflineAuthorityRefresh(deps: OfflineAuthorityRefreshDeps): () => void {
  const refresh = createOfflineAuthorityRefresh(deps);
  const timer = setInterval(() => void refresh.tick(), OFFLINE_AUTHORITY_TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
