import { verify, type KeyObject } from "node:crypto";
import {
  terminalSigningText,
  type OfflineJournalCommand,
  type OfflineStaffSignIn,
  type Signed,
  type SyncAcknowledgement,
  type SyncRequest,
  type SyncResponse,
  type TerminalIdentity,
} from "@pharmaceylon/shared";
import type { JournalSync } from "../../shared/ipc-contract";
import { ApiError, type ApiSession } from "../api/api-client";
import type { PosDatabase } from "../db/database";
import {
  activeOutage,
  journalCoverage,
  localJournalHead,
} from "./offline-journal";
import type { OfflineAuthorityRefresh } from "./offline-authority-refresh";
import {
  createJournalRecovery,
  explainRecovery,
  readLocalRecovery,
  type JournalRecovery,
} from "./journal-recovery";
import {
  checkoutSyncPause,
  drainAwaitsFreshSnapshot,
  ensureSyncRow,
  finishDrainWithoutRenewal,
  readAcceptedWatermark,
  recordAcceptedWatermark,
  type CheckoutSyncPause,
} from "./reconnect-drain";
import type { TerminalService } from "./terminal-service";

/** How often the counter looks; most looks end locally (nothing to send, or backing off). */
export const JOURNAL_SYNC_TICK_MS = 15_000;
/** With nothing waiting, the server confirms the whole journal this often (the "last sync" time). */
export const JOURNAL_CONFIRM_MS = 5 * 60_000;
/** Entries per request. The server processes them one transaction each, in order. */
export const JOURNAL_BATCH = 50;
/** Batches per cycle, so one cycle can't run unbounded on a very long journal. */
const MAX_BATCHES = 20;
const FIRST_BACKOFF_MS = 15_000;
/** After a cycle the server answered but that left an issue (a held entry, a mismatch), look again this much later. */
export const ISSUE_RETRY_MS = 60_000;
const TRANSIENT_BACKOFF_CAP_MS = 2 * 60_000;
const PERSISTENT_BACKOFF_CAP_MS = 15 * 60_000;

/** `app_meta` keys the title and status bars read (P2b #103, PR 138). */
export const SYNC_IN_PROGRESS_KEY = "counter_sync_in_progress";
export const LAST_SUCCESSFUL_SYNC_KEY = "counter_last_successful_sync_at";

const SYNC_PATH = "/terminals/offline-journal/sync";

/** Whole-request refusals that won't clear until someone changes something. */
const PERSISTENT_CODES = new Set([
  "IDENTITY_MISMATCH",
  "INVALID_SIGNATURE",
  "PERMISSION_DENIED",
  "INVALID_COMMAND",
  "UNSUPPORTED_CONTRACT",
  "BAD_REQUEST",
  "FORBIDDEN",
  "NOT_FOUND",
  "RESPONSE_INVALID",
  "TERMINAL_REVOKED",
]);

/** A reply that fails verification. Nothing in it is applied. */
export class SyncResponseInvalid extends Error {
  readonly code = "RESPONSE_INVALID";
  constructor(reason: string) {
    super(`Sync response not accepted: ${reason}`);
    this.name = "SyncResponseInvalid";
  }
}

type CommandRow = {
  command_id: string;
  sequence: number;
  payload_hash: string;
  envelope_json: string;
  sync_status: "pending" | "synced" | "failed";
};

/** What was sent, by command ID, to check the acknowledgements against. */
type Sent = ReadonlyMap<
  string,
  { sequence: number; hash: string; kind: OfflineJournalCommand["kind"] }
>;

const identityKeys = [
  "tenantId",
  "branchId",
  "terminalId",
  "enrollmentId",
  "keyId",
] as const;
const hex64 = /^[a-f0-9]{64}$/;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const safeInt = (v: unknown, min = 0): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min;

/**
 * Verifies the server's signed `SyncResponse` (P5 #51) before anything in it is trusted: the
 * offline authority key and `sync_response` purpose, this exact counter, a watermark in canonical
 * form, and one acknowledgement per entry sent, in order, naming its exact hash and sequence
 * ("Only a signed, identity-matching server response with command ID/digest and receipt may mark
 * a local item acknowledged").
 */
export function verifySyncResponse(
  envelope: unknown,
  expected: {
    identity: TerminalIdentity;
    signer: { keyId: string; publicKey: KeyObject };
    sent: Sent;
  },
): SyncResponse {
  if (
    !isRecord(envelope) ||
    envelope.algorithm !== "Ed25519" ||
    envelope.keyId !== expected.signer.keyId ||
    typeof envelope.signature !== "string" ||
    !/^[A-Za-z0-9_-]{86}$/.test(envelope.signature) ||
    !isRecord(envelope.payload)
  )
    throw new SyncResponseInvalid("envelope");
  const signature = Buffer.from(envelope.signature, "base64url");
  let authentic = false;
  try {
    authentic =
      signature.toString("base64url") === envelope.signature &&
      verify(
        null,
        Buffer.from(terminalSigningText("sync_response", envelope.payload)),
        expected.signer.publicKey,
        signature,
      );
  } catch {
    authentic = false;
  }
  if (!authentic) throw new SyncResponseInvalid("signature");
  const payload = envelope.payload as unknown as SyncResponse;
  if (
    payload.contractVersion !== 1 ||
    !isRecord(payload.identity) ||
    !identityKeys.every((k) => payload.identity[k] === expected.identity[k])
  )
    throw new SyncResponseInvalid("identity");
  if (
    !safeInt(payload.committedThroughSequence) ||
    (payload.committedThroughSequence === 0
      ? payload.committedThroughHash !== null
      : typeof payload.committedThroughHash !== "string" ||
        !hex64.test(payload.committedThroughHash))
  )
    throw new SyncResponseInvalid("watermark");
  if (
    !Array.isArray(payload.acknowledgements) ||
    !Array.isArray(payload.supportAcknowledgements)
  )
    throw new SyncResponseInvalid("acknowledgements");

  const seen = new Set<string>();
  let previous = 0;
  let stopped = false;
  for (const ack of payload.acknowledgements as unknown[]) {
    if (!isRecord(ack) || typeof ack.commandId !== "string")
      throw new SyncResponseInvalid("acknowledgement");
    const sent = expected.sent.get(ack.commandId);
    // Exactly what was sent, once each, in sequence order; nothing after a refusal.
    if (
      !sent ||
      seen.has(ack.commandId) ||
      ack.commandHash !== sent.hash ||
      ack.sequence !== sent.sequence ||
      sent.sequence <= previous ||
      stopped
    )
      throw new SyncResponseInvalid("acknowledgement");
    seen.add(ack.commandId);
    previous = sent.sequence;
    if (ack.status === "committed" || ack.status === "duplicate") {
      if (
        ack.commandKind !== sent.kind ||
        !safeInt(ack.committedAt) ||
        sent.sequence > payload.committedThroughSequence
      )
        throw new SyncResponseInvalid("acknowledgement");
      if (sent.kind === "ordinary_sale") {
        const posted =
          ack.stockPosting === "posted" && ack.reconciliationCaseId === null;
        const pending =
          ack.stockPosting === "pending_reconciliation" &&
          typeof ack.reconciliationCaseId === "string";
        if (typeof ack.saleId !== "string" || !(posted || pending))
          throw new SyncResponseInvalid("acknowledgement");
      } else if (typeof ack.workSessionId !== "string")
        throw new SyncResponseInvalid("acknowledgement");
    } else if (ack.status === "held" || ack.status === "rejected") {
      if (
        !isRecord(ack.error) ||
        typeof ack.error.code !== "string" ||
        typeof ack.error.message !== "string"
      )
        throw new SyncResponseInvalid("acknowledgement");
      stopped = true;
    } else throw new SyncResponseInvalid("acknowledgement");
  }
  return payload;
}

/** What is stopping the journal from being fully confirmed, in plain words for the counter. */
export type JournalSyncIssue = {
  code: string;
  message: string;
  sequence: number | null;
  at: string;
};

/** The journal's sync state for readiness, the Sell page and This counter. */
export type JournalSyncView = {
  /** Entries recorded here, and how many of them the server has accepted (signed evidence). */
  recorded: number;
  accepted: number;
  /** Recorded here, not yet accepted. */
  waiting: number;
  /** Refused for good: they need review before anything after them can be accepted. */
  refused: number;
  syncing: boolean;
  /** When the server last confirmed every entry recorded here (ISO). */
  lastSuccessAt: string | null;
  issue: JournalSyncIssue | null;
  outage: { offlineSessionId: string; startedAt: number } | null;
  lastDrain: { outageId: string; startedAt: number; drainedAt: string } | null;
  pause: CheckoutSyncPause | null;
};

export type OfflineJournalSyncDeps = {
  db: PosDatabase;
  api: Pick<ApiSession, "request">;
  terminal: Pick<TerminalService, "current">;
  /** The server's offline authority key; it also signs sync responses. */
  signer: { keyId: string; publicKey: KeyObject };
  report: (error: unknown) => void;
  now?: () => number;
};

function setMeta(
  db: PosDatabase,
  key: string,
  value: string,
  at: string,
): void {
  db.prepare(
    `INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, at);
}

/** Plain words for a refusal code, for the counter's staff. */
export function explainSyncIssue(code: string): string {
  switch (code) {
    case "NETWORK":
    case "TEMPORARILY_UNAVAILABLE":
    case "RATE_LIMITED":
    case "SERVER_ERROR":
      return "The server could not be reached. It retries by itself.";
    case "RESPONSE_INVALID":
      return "The server's reply did not match this computer's offline key. Contact support.";
    case "JOURNAL_MISMATCH":
      return "The server holds offline records from this counter that this computer doesn't. Don't sell offline here; this computer reports it to the back office by itself.";
    case "IDENTITY_MISMATCH":
    case "INVALID_SIGNATURE":
      return "The server did not recognise this counter's offline records. Contact support.";
    case "PERMISSION_DENIED":
      return "The person signed in can't upload this counter's offline sales. A cashier or manager signs in to finish.";
    case "TERMINAL_REVOKED":
      return "This counter was switched off in the back office. Its offline sales are kept on the server for review.";
    case "SESSION_INVALID":
      return "A staff sign-in an offline sale names is missing. Contact support.";
    case "BUSINESS_HOURS_ACK_REQUIRED":
      return "A manager's after-hours approval an offline sale names has not reached the server yet.";
    case "SEQUENCE_GAP":
      return "An earlier offline record has to reach the server first. It retries by itself.";
    case "REPLAY_CONFLICT":
      return "An offline record doesn't match what the server already has. A manager reviews it in the back office.";
    default:
      return `The server refused an offline record (${code}). A manager reviews it in the back office.`;
  }
}

/**
 * Uploads this counter's offline journal (P4's `offline_journal_command`) to
 * `POST /terminals/offline-journal/sync` and records what the server's signed reply proves (P5 #51).
 *
 * - Entries go in sequence order from the first one not yet accepted, with every staff sign-in they
 *   cite, in batches. A refused entry stops the upload where the server stopped: `held` ones are
 *   sent again (the next cycle may repair them), `rejected` ones never are — they wait for review.
 * - Only a verified, signed reply marks an entry accepted, with its acknowledgement kept beside it.
 *   A lost reply is recovered by sending the same entries again: the server answers `duplicate`
 *   with the original receipt.
 * - The server's watermark is recorded only if it names this computer's own chain. One that names
 *   entries this computer doesn't have (`JOURNAL_MISMATCH`) is a recovery issue, never adopted.
 * - With nothing waiting, an empty upload every five minutes has the server confirm the whole
 *   journal. That confirmation is the counter's "last sync" (`counter_last_successful_sync_at`).
 *
 * Nothing here ends an outage: the rebasing installer does, once a fresh pair covers the journal.
 */
export function createOfflineJournalSync(deps: OfflineJournalSyncDeps) {
  const now = deps.now ?? Date.now;
  const iso = () => new Date(now()).toISOString();
  let inFlight = false;
  let consecutiveFailures = 0;
  let nextAttemptAt: number | null = null;

  // A cycle cut short by a crash or quit leaves no sync running.
  setMeta(deps.db, SYNC_IN_PROGRESS_KEY, "0", iso());

  function setIssue(
    enrollmentId: string,
    issue: { code: string; message?: string; sequence?: number | null } | null,
  ) {
    const at = iso();
    ensureSyncRow(deps.db, enrollmentId, at);
    deps.db
      .prepare(
        `UPDATE offline_journal_sync SET issue_code = ?, issue_message = ?, issue_sequence = ?, issue_at = ?, updated_at = ?
       WHERE enrollment_id = ?`,
      )
      .run(
        issue?.code ?? null,
        issue ? (issue.message ?? explainSyncIssue(issue.code)) : null,
        issue?.sequence ?? null,
        issue ? at : null,
        at,
        enrollmentId,
      );
  }

  function unsynced(enrollmentId: string): CommandRow[] {
    return deps.db
      .prepare(
        `SELECT command_id, sequence, payload_hash, envelope_json, sync_status FROM offline_journal_command
         WHERE enrollment_id = ? AND sync_status <> 'synced' ORDER BY sequence LIMIT ?`,
      )
      .all(enrollmentId, JOURNAL_BATCH) as CommandRow[];
  }

  /** The staff sign-ins the batch cites: each entry's own, and an assisted close's manager. */
  function signInsFor(
    enrollmentId: string,
    commands: Signed<OfflineJournalCommand>[],
  ): Signed<OfflineStaffSignIn>[] {
    const ids = new Set<string>();
    for (const { payload } of commands) {
      ids.add(payload.staffSignInId);
      if (payload.kind === "shift_close" && payload.assistance)
        ids.add(payload.assistance.managerSignInId);
    }
    const read = deps.db.prepare(
      "SELECT envelope_json FROM offline_journal_staff_sign_in WHERE enrollment_id = ? AND staff_sign_in_id = ?",
    );
    const found: Signed<OfflineStaffSignIn>[] = [];
    for (const id of ids) {
      const row = read.get(enrollmentId, id) as
        | { envelope_json: string }
        | undefined;
      // A missing one is sent without: the server holds the entry (SESSION_INVALID) and says so.
      if (row)
        found.push(JSON.parse(row.envelope_json) as Signed<OfflineStaffSignIn>);
    }
    return found;
  }

  function confirmDue(enrollmentId: string): boolean {
    const row = deps.db
      .prepare(
        "SELECT last_success_at, issue_code FROM offline_journal_sync WHERE enrollment_id = ?",
      )
      .get(enrollmentId) as
      | { last_success_at: string | null; issue_code: string | null }
      | undefined;
    if (!row?.last_success_at || row.issue_code) return true;
    return now() - Date.parse(row.last_success_at) >= JOURNAL_CONFIRM_MS;
  }

  /** Applies one verified reply in a single transaction. Returns whether the journal is fully confirmed. */
  function apply(
    enrollmentId: string,
    response: SyncResponse,
    sentRows: CommandRow[],
  ): boolean {
    return deps.db
      .transaction((): boolean => {
        const at = iso();
        ensureSyncRow(deps.db, enrollmentId, at);
        deps.db
          .prepare(
            "UPDATE offline_journal_sync SET last_attempt_at = ?, updated_at = ? WHERE enrollment_id = ?",
          )
          .run(at, at, enrollmentId);
        const accept = deps.db.prepare(
          `UPDATE offline_journal_command SET sync_status = 'synced', acknowledgement_json = ?, acknowledged_at = ?,
           last_error_code = NULL
         WHERE enrollment_id = ? AND command_id = ? AND sync_status <> 'synced'`,
        );
        const refuse = deps.db.prepare(
          `UPDATE offline_journal_command SET sync_status = ?, last_error_code = ?
         WHERE enrollment_id = ? AND command_id = ? AND sync_status <> 'synced'`,
        );
        let issue: {
          code: string;
          message: string;
          sequence: number | null;
        } | null = null;
        for (const ack of response.acknowledgements as SyncAcknowledgement[]) {
          if ("error" in ack) {
            refuse.run(
              ack.status === "rejected" ? "failed" : "pending",
              ack.error.code,
              enrollmentId,
              ack.commandId,
            );
            issue = {
              code: ack.error.code,
              message: explainSyncIssue(ack.error.code),
              sequence: ack.sequence,
            };
          } else {
            accept.run(JSON.stringify(ack), at, enrollmentId, ack.commandId);
          }
        }
        const watermark = {
          sequence: response.committedThroughSequence,
          hash: response.committedThroughHash,
        };
        const coverage = journalCoverage(deps.db, enrollmentId, watermark);
        const recorded =
          coverage !== "mismatch" &&
          recordAcceptedWatermark(deps.db, enrollmentId, watermark, at);
        if (!recorded) {
          // The server's journal for this enrollment is not this computer's: it holds entries this
          // computer lost or never wrote (a restored backup, a damaged journal), or it accepted
          // less than it confirmed before. Never adopted; P4 refuses to start an outage on it.
          issue = {
            code: "JOURNAL_MISMATCH",
            message: explainSyncIssue("JOURNAL_MISMATCH"),
            sequence: watermark.sequence,
          };
        }
        if (
          !issue &&
          sentRows.some(
            (row) =>
              !response.acknowledgements.some(
                (a) => a.commandId === row.command_id,
              ),
          )
        )
          issue = {
            code: "SERVER_ERROR",
            message: explainSyncIssue("SERVER_ERROR"),
            sequence: null,
          };
        setIssue(enrollmentId, issue);
        const complete = !issue && coverage === "covered";
        if (complete) {
          deps.db
            .prepare(
              "UPDATE offline_journal_sync SET last_success_at = ?, updated_at = ? WHERE enrollment_id = ?",
            )
            .run(at, at, enrollmentId);
          setMeta(deps.db, LAST_SUCCESSFUL_SYNC_KEY, at, at);
        }
        return complete;
      })
      .immediate();
  }

  /** One request: the next batch, or an empty confirmation. Returns whether to send another batch. */
  async function send(
    identity: TerminalIdentity,
    rows: CommandRow[],
  ): Promise<{ complete: boolean; more: boolean }> {
    const commands = rows.map(
      (row) => JSON.parse(row.envelope_json) as Signed<OfflineJournalCommand>,
    );
    const body: SyncRequest = {
      contractVersion: 1,
      identity,
      staffSignIns: signInsFor(identity.enrollmentId, commands),
      commands,
      // P4 #50 produces no support records on this computer yet.
      supportRecords: [],
    };
    const sent: Sent = new Map(
      rows.map((row, i) => [
        row.command_id,
        {
          sequence: row.sequence,
          hash: row.payload_hash,
          kind: commands[i]!.payload.kind,
        },
      ]),
    );
    const reply = await deps.api.request<unknown>("POST", SYNC_PATH, {
      branchId: identity.branchId,
      body,
    });
    const response = verifySyncResponse(reply, {
      identity,
      signer: deps.signer,
      sent,
    });
    const complete = apply(identity.enrollmentId, response, rows);
    const allAccepted =
      response.acknowledgements.length === rows.length &&
      response.acknowledgements.every(
        (a) => a.status === "committed" || a.status === "duplicate",
      );
    return {
      complete,
      more: !complete && rows.length === JOURNAL_BATCH && allAccepted,
    };
  }

  /** `issue`: the server answered, but something it said stops the journal being confirmed. */
  async function cycle(force: boolean): Promise<"done" | "issue" | "skipped"> {
    const current = deps.terminal.current();
    if (!current) return "skipped";
    const { identity } = current;
    const enrollmentId = identity.enrollmentId;
    let rows = unsynced(enrollmentId);
    // A refused entry blocks the chain until it is reviewed; resending it changes nothing.
    if (rows[0]?.sync_status === "failed") return "skipped";
    if (!rows.length && !force && !confirmDue(enrollmentId)) return "skipped";
    setMeta(deps.db, SYNC_IN_PROGRESS_KEY, "1", iso());
    try {
      for (let batch = 0; batch < MAX_BATCHES; batch++) {
        const result = await send(
          identity,
          rows.filter((row) => row.sync_status === "pending"),
        );
        if (!result.more) break;
        rows = unsynced(enrollmentId);
        if (!rows.length || rows[0]!.sync_status !== "pending") break;
      }
      return readJournalSyncView(deps.db, enrollmentId).issue
        ? "issue"
        : "done";
    } finally {
      setMeta(deps.db, SYNC_IN_PROGRESS_KEY, "0", iso());
    }
  }

  function failureCode(error: unknown): string {
    if (error instanceof SyncResponseInvalid) return error.code;
    if (error instanceof ApiError) {
      if (error.status === 0) return "NETWORK";
      if (error.status >= 500)
        return error.code.startsWith("HTTP_") ? "SERVER_ERROR" : error.code;
      if (error.code === "AUTHENTICATION_REQUIRED") return "NETWORK";
      return error.code;
    }
    return "SERVER_ERROR";
  }

  return {
    /** One look. Never throws: failures are recorded, reported and delay the next attempt. */
    async tick(options: { force?: boolean } = {}): Promise<void> {
      if (
        inFlight ||
        (!options.force && nextAttemptAt !== null && now() < nextAttemptAt)
      )
        return;
      inFlight = true;
      try {
        const result = await cycle(options.force ?? false);
        consecutiveFailures = 0;
        // Answered, but something still stops the journal from being confirmed: don't resend
        // held entries every few seconds; the server keeps them for review meanwhile.
        nextAttemptAt = result === "issue" ? now() + ISSUE_RETRY_MS : null;
      } catch (error) {
        const current = deps.terminal.current();
        const code = failureCode(error);
        if (current) {
          try {
            setIssue(current.identity.enrollmentId, { code });
          } catch (recordError) {
            deps.report(recordError);
          }
        }
        consecutiveFailures += 1;
        const cap = PERSISTENT_CODES.has(code)
          ? PERSISTENT_BACKOFF_CAP_MS
          : TRANSIENT_BACKOFF_CAP_MS;
        nextAttemptAt =
          now() +
          Math.min(cap, FIRST_BACKOFF_MS * 2 ** (consecutiveFailures - 1));
        deps.report(error);
      } finally {
        inFlight = false;
      }
    },
    /** The journal's sync state for an enrollment, from the local store. */
    view(enrollmentId: string): JournalSyncView {
      return readJournalSyncView(deps.db, enrollmentId, inFlight);
    },
  };
}

export type OfflineJournalSync = ReturnType<typeof createOfflineJournalSync>;

/** The journal's sync state, from the local store alone (it answers while locked or offline). */
export function readJournalSyncView(
  db: PosDatabase,
  enrollmentId: string,
  syncing = false,
): JournalSyncView {
  const head = localJournalHead(db, enrollmentId);
  const accepted = readAcceptedWatermark(db, enrollmentId);
  const refused = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM offline_journal_command WHERE enrollment_id = ? AND sync_status = 'failed'",
      )
      .get(enrollmentId) as { n: number }
  ).n;
  const row = db
    .prepare(
      `SELECT last_success_at, issue_code, issue_message, issue_sequence, issue_at,
              drained_outage_id, drained_outage_started_at, drained_at
       FROM offline_journal_sync WHERE enrollment_id = ?`,
    )
    .get(enrollmentId) as
    | {
        last_success_at: string | null;
        issue_code: string | null;
        issue_message: string | null;
        issue_sequence: number | null;
        issue_at: string | null;
        drained_outage_id: string | null;
        drained_outage_started_at: number | null;
        drained_at: string | null;
      }
    | undefined;
  const outage = activeOutage(db, enrollmentId);
  // P5 #51, D11: while a journal recovery is under way, say where it stands.
  const recovery =
    row?.issue_code === "JOURNAL_MISMATCH"
      ? explainRecovery(readLocalRecovery(db, enrollmentId))
      : null;
  return {
    recorded: head.sequence,
    accepted: accepted.sequence,
    waiting: Math.max(0, head.sequence - accepted.sequence),
    refused,
    syncing,
    lastSuccessAt: row?.last_success_at ?? null,
    issue: row?.issue_code
      ? {
          code: row.issue_code,
          message:
            recovery ?? row.issue_message ?? explainSyncIssue(row.issue_code),
          sequence: row.issue_sequence,
          at: row.issue_at ?? "",
        }
      : null,
    outage: outage
      ? {
          offlineSessionId: outage.offlineSessionId,
          startedAt: outage.offlineStartedAt,
        }
      : null,
    lastDrain:
      row?.drained_outage_id && row.drained_at
        ? {
            outageId: row.drained_outage_id,
            startedAt: row.drained_outage_started_at ?? 0,
            drainedAt: row.drained_at,
          }
        : null,
    pause: checkoutSyncPause(db, enrollmentId),
  };
}

/** Renewal refusals meaning this counter gets no offline authority, so no rebased pair will come. */
const NO_OFFLINE_AUTHORITY = new Set(["GRANT_INVALID"]);

/**
 * One reconnect cycle (P5 #51, approved D12): upload the journal; once it is all accepted and
 * nothing sent is uncertain, ask for a fresh pair at once (installing it finishes the drain); if
 * the server refuses this counter offline authority altogether, finish the drain without one.
 * A journal the server says is not its own goes through the D11 recovery instead, and a fresh
 * pair is asked for as soon as that completes.
 * Each step reads trusted local state; none relies on the previous one having run.
 */
export function createSyncCoordinator(deps: {
  db: PosDatabase;
  sync: Pick<OfflineJournalSync, "tick">;
  recovery?: Pick<JournalRecovery, "tick"> | null;
  refresh: Pick<OfflineAuthorityRefresh, "tick" | "status" | "renewNow"> | null;
  terminal: Pick<TerminalService, "current">;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  /** One immediate renewal per outage and journal head; after that, the refresh's own back-off. */
  let renewalAskedFor: string | null = null;
  return async function cycle(): Promise<void> {
    await deps.sync.tick();
    if (deps.recovery && (await deps.recovery.tick()) === "recovered")
      deps.refresh?.renewNow();
    const current = deps.terminal.current();
    if (!current || !deps.refresh) return;
    const enrollmentId = current.identity.enrollmentId;
    if (!drainAwaitsFreshSnapshot(deps.db, enrollmentId)) return;
    const key = `${activeOutage(deps.db, enrollmentId)?.offlineSessionId}:${localJournalHead(deps.db, enrollmentId).sequence}`;
    if (renewalAskedFor !== key) {
      renewalAskedFor = key;
      deps.refresh.renewNow();
      await deps.refresh.tick();
    }
    const status = deps.refresh.status();
    if (
      status.nominated === false ||
      (status.lastFailure && NO_OFFLINE_AUTHORITY.has(status.lastFailure.code))
    )
      finishDrainWithoutRenewal(
        deps.db,
        enrollmentId,
        new Date(now()).toISOString(),
      );
  };
}

/** Starts the journal sync and the reconnect coordinator on a timer. */
export function startOfflineJournalSync(
  deps: OfflineJournalSyncDeps & { refresh: OfflineAuthorityRefresh | null },
): { sync: OfflineJournalSync; stop: () => void } {
  const sync = createOfflineJournalSync(deps);
  const recovery = createJournalRecovery(deps);
  const cycle = createSyncCoordinator({
    db: deps.db,
    sync,
    recovery,
    refresh: deps.refresh,
    terminal: deps.terminal,
    now: deps.now,
  });
  const run = () => void cycle().catch(deps.report);
  const timer = setInterval(run, JOURNAL_SYNC_TICK_MS);
  timer.unref();
  run();
  return { sync, stop: () => clearInterval(timer) };
}

/** Nothing to show: not enrolled, or no journal. */
export const EMPTY_JOURNAL_SYNC: JournalSync = {
  recorded: 0,
  accepted: 0,
  waiting: 0,
  refused: 0,
  syncing: false,
  lastSuccessAt: null,
  issue: null,
  pause: null,
  lastDrainAt: null,
};

/** The renderer's view of the journal sync: counts, plain words and ISO times only. */
export function journalSyncState(view: JournalSyncView | null): JournalSync {
  if (!view) return EMPTY_JOURNAL_SYNC;
  return {
    recorded: view.recorded,
    accepted: view.accepted,
    waiting: view.waiting,
    refused: view.refused,
    syncing: view.syncing,
    lastSuccessAt: view.lastSuccessAt,
    issue: view.issue && { code: view.issue.code, message: view.issue.message },
    pause: view.pause && {
      reason: view.pause.reason,
      waiting: view.pause.waiting,
      outageStartedAt:
        view.pause.outageStartedAt === null
          ? null
          : new Date(view.pause.outageStartedAt).toISOString(),
    },
    lastDrainAt: view.lastDrain?.drainedAt ?? null,
  };
}
