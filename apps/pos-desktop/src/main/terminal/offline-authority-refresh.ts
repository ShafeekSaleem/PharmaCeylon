import { randomUUID, type KeyObject } from "node:crypto";
import type { OnlineTerminalCommand } from "@pharmaceylon/shared";
import type { ApiSession } from "../api/api-client";
import type { PosDatabase } from "../db/database";
import { installInitialOfflineAuthority, type OfflineAuthority } from "./offline-authority";
import type { TerminalService } from "./terminal-service";

const operation = "POST /api/v1/terminals/offline-authority";

export function startOfflineAuthorityRefresh(
  db: PosDatabase,
  api: ApiSession,
  terminal: TerminalService,
  readDevice: () => { registerId: string; tillId: string } | null,
  signer: { keyId: string; publicKey: KeyObject },
  report: (error: unknown) => void,
) {
  let inFlight = false;
  const refresh = async () => {
    const current = terminal.current();
    const device = readDevice();
    if (inFlight || !current || !device) return;
    const { identity, key, staff } = current;
    if (db.prepare("SELECT 1 FROM offline_authority WHERE enrollment_id = ?").get(identity.enrollmentId)) return;
    inFlight = true;
    try {
      db.prepare(`
        INSERT INTO offline_authority_request (enrollment_id, request_id)
        VALUES (?, ?) ON CONFLICT(enrollment_id) DO NOTHING
      `).run(identity.enrollmentId, randomUUID());
      const { request_id: requestId } = db.prepare(`
        SELECT request_id FROM offline_authority_request WHERE enrollment_id = ?
      `).get(identity.enrollmentId) as { request_id: string };
      const branchId = identity.branchId;
      const command = await api.request<OnlineTerminalCommand<{ requestId: string }>>(
        "POST", "/terminals/offline-authority/challenge", {
          branchId, body: { workSessionId: staff.workSessionId, requestId },
        },
      );
      if (command.operation !== operation || command.body.requestId !== requestId ||
          Object.keys(command.body).length !== 1 ||
          Object.keys(identity).some((field) => command.identity[field as keyof typeof identity] !== identity[field as keyof typeof identity]) ||
          command.session.registerId !== device.registerId || command.session.tillId !== device.tillId ||
          command.session.staffUserId !== staff.staffUserId || command.session.workSessionId !== staff.workSessionId) throw new Error("Unexpected offline authority challenge");
      const proof = await terminal.attendCommand(command);
      const response = await api.request<OfflineAuthority>("POST", "/terminals/offline-authority", {
        branchId, body: { envelope: key.sign(command, "command"), attendanceProofId: proof.proofId },
      });
      if (terminal.current()?.staff.workSessionId !== staff.workSessionId) return;
      const result = installInitialOfflineAuthority(db, response, {
        identity, registerId: device.registerId, tillId: device.tillId, signer, trustedNow: Date.now(),
      });
      if (result !== "installed" && result !== "already_installed") throw new Error(result);
    } finally {
      inFlight = false;
    }
  };
  const timer = setInterval(() => { void refresh().catch(report); }, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
