import {
  terminalSigningText,
  type OnlineCommandReceipt,
  type OnlineTerminalCommand,
  type Signed,
  type SignedOperationBody,
  type SignedPhysicalOperation,
} from "@pharmaceylon/shared";
import { ApiError, type ApiSession } from "../api/api-client";
import type { PosDatabase } from "../db/database";
import type { Logger } from "../logging/logger";
import { ActionFailure, type TerminalService } from "./terminal-service";

type Row = {
  command_id: string;
  operation: string;
  staff_user_id: string;
  envelope_json: string;
  attendance_proof_id: string;
  status: "sent" | "receipted" | "uncertain" | "refused";
};

/**
 * Physical execution through the P1 signed-command executor: prepare on the server, prove local
 * attendance for that exact command, sign it with the device key, keep the envelope, execute.
 * The server rechecks staff authority, the approval evidence, the operation's own permission and
 * domain limits inside one transaction, and records requester, approver and executor separately.
 */
export class SignedCommandService {
  constructor(
    private readonly deps: {
      db: PosDatabase;
      api: ApiSession;
      terminal: TerminalService;
      logger: Logger;
      now?: () => Date;
    },
  ) {}

  private now() {
    return (this.deps.now ?? (() => new Date()))().toISOString();
  }

  async execute<O extends SignedPhysicalOperation>(
    operation: O,
    body: SignedOperationBody[O],
    approvalEvidenceId: string | null,
  ): Promise<OnlineCommandReceipt<O>> {
    const current = this.deps.terminal.current();
    if (!current)
      throw new ActionFailure(
        "NOT_SIGNED_IN",
        "Sign in at this counter first.",
      );
    const { staff, identity, key } = current;
    const command = await this.deps.api.request<
      OnlineTerminalCommand<SignedOperationBody[O]>
    >("POST", "/terminal-commands/prepare", {
      branchId: identity.branchId,
      body: {
        workSessionId: staff.workSessionId,
        operation,
        body,
        approvalEvidenceId,
        pharmacistEvidenceId: null,
        operatingHoursExceptionId: null,
      },
    });
    // Sign only what was asked for: the server must not have changed the operation or body.
    if (
      command.operation !== operation ||
      terminalSigningText("command", command.body) !==
        terminalSigningText("command", body) ||
      command.approvalEvidenceId !== approvalEvidenceId ||
      command.identity.enrollmentId !== identity.enrollmentId
    )
      throw new ActionFailure(
        "CHALLENGE_INVALID",
        "The server prepared a different command. Nothing was done.",
      );
    const proof = await this.deps.terminal.attendCommand(command);
    const envelope = key.sign(command, "command");
    const at = this.now();
    this.deps.db
      .prepare(
        `INSERT INTO signed_command (command_id, operation, staff_user_id, envelope_json, attendance_proof_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'sent', ?, ?)`,
      )
      .run(
        command.commandId,
        operation,
        staff.staffUserId,
        JSON.stringify(envelope),
        proof.proofId,
        at,
        at,
      );
    return this.send<O>(
      command.commandId,
      envelope,
      proof.proofId,
      identity.branchId,
    );
  }

  /** Commands sent without a definite answer, to be resent identically. */
  pending(): { commandId: string; operation: string; createdAt: string }[] {
    const rows = this.deps.db
      .prepare(
        "SELECT command_id, operation, created_at FROM signed_command WHERE status IN ('sent', 'uncertain') ORDER BY created_at",
      )
      .all() as { command_id: string; operation: string; created_at: string }[];
    return rows.map((r) => ({
      commandId: r.command_id,
      operation: r.operation,
      createdAt: r.created_at,
    }));
  }

  async retry(commandId: string): Promise<OnlineCommandReceipt> {
    const current = this.deps.terminal.current();
    if (!current)
      throw new ActionFailure(
        "NOT_SIGNED_IN",
        "Sign in at this counter first.",
      );
    const row = this.deps.db
      .prepare("SELECT * FROM signed_command WHERE command_id = ?")
      .get(commandId) as Row | undefined;
    if (!row || (row.status !== "sent" && row.status !== "uncertain"))
      throw new ActionFailure(
        "COMMAND_NOT_PENDING",
        "That action is not waiting to be confirmed.",
      );
    if (row.staff_user_id !== current.staff.staffUserId)
      throw new ActionFailure(
        "COMMAND_OTHER_STAFF",
        "Only the person who sent it can confirm it.",
      );
    return this.send(
      row.command_id,
      JSON.parse(row.envelope_json) as Signed<unknown>,
      row.attendance_proof_id,
      current.identity.branchId,
    );
  }

  private mark(
    commandId: string,
    status: Row["status"],
    fields: { receipt?: unknown; errorCode?: string },
  ) {
    this.deps.db
      .prepare(
        "UPDATE signed_command SET status = ?, receipt_json = COALESCE(?, receipt_json), error_code = ?, updated_at = ? WHERE command_id = ?",
      )
      .run(
        status,
        fields.receipt === undefined ? null : JSON.stringify(fields.receipt),
        fields.errorCode ?? null,
        this.now(),
        commandId,
      );
  }

  private async send<O extends SignedPhysicalOperation>(
    commandId: string,
    envelope: Signed<unknown>,
    attendanceProofId: string,
    branchId: string,
  ): Promise<OnlineCommandReceipt<O>> {
    try {
      const receipt = await this.deps.api.request<OnlineCommandReceipt<O>>(
        "POST",
        "/terminal-commands/execute",
        {
          branchId,
          body: { command: envelope, attendanceProofId },
        },
      );
      this.mark(commandId, "receipted", { receipt });
      this.deps.logger.info("terminal.command_receipted", {
        commandId,
        replayed: receipt.replayed,
      });
      return receipt;
    } catch (error) {
      if (error instanceof ApiError && error.uncertain) {
        this.mark(commandId, "uncertain", { errorCode: error.code });
        throw new ActionFailure(
          "COMMAND_UNCERTAIN",
          "The server did not answer. Confirm this action before trying again.",
        );
      }
      this.mark(commandId, "refused", {
        errorCode: error instanceof ApiError ? error.code : "UNEXPECTED",
      });
      throw error;
    }
  }
}
