import { randomUUID } from "node:crypto";
import {
  containsCardNumber,
  type ExternalCardAttemptRecord,
  type OfflineGrant,
  type OfflineJournalCommand,
  type OfflineSaleCommand,
  type OfflineSaleIncident,
  type OfflineStaffSignIn,
  type Signed,
} from "@pharmaceylon/shared";
import type { PosDatabase } from "../db/database";
import { verifyDeviceCommandSignature } from "./device-signature";
import { readInstalledOfflineAuthority } from "./offline-authority";
import {
  journalCommandHash,
  readEnrolledDevice,
  sameTerminalIdentity,
} from "./offline-journal-writer";
import { storeRestoreBlocksOffline } from "./store-restore-sync";

/**
 * P4 #50: writes the counter's offline support records — sale-incident notes and external-card
 * attempt events — as device-signed evidence, ready for P5's upload (`offline-journal-sync.ts`).
 *
 * These records are a stream apart from the journal: they take no journal sequence and never post
 * a sale, payment, stock or cash effect. Everything the server later checks about them is checked
 * here first, so a record that would be refused is never signed:
 * - the counter's identity is read from the enrolled device, never from the caller;
 * - the sign-in the record cites exists here, is this person's, and the record sits inside the
 *   installed grant's window;
 * - free text carries no full card number (`containsCardNumber`); a stored one can never be removed;
 * - a card attempt is persisted as `prepared` before the separate card machine is asked to charge,
 *   each later state change is its own immutable event, and the attempt's draft, digest and amount
 *   are fixed by its first event.
 *
 * Nothing here calls the card machine or the network.
 */

export const MAX_INCIDENT_DESCRIPTION_LENGTH = 1000;
const MAX_PROVIDER_REFERENCE_LENGTH = 64;
const MAX_APPROVAL_CODE_LENGTH = 32;

export const SALE_INCIDENT_CATEGORIES: readonly OfflineSaleIncident["category"][] =
  ["quantity_error", "payment_uncertain", "customer_dispute", "other"];

type CardState = ExternalCardAttemptRecord["state"];

/** What can follow each state. `declined` and `linked_to_sale` end the attempt. */
const NEXT_CARD_STATES: Readonly<Record<CardState, readonly CardState[]>> = {
  prepared: ["uncertain", "approved", "declined"],
  uncertain: ["approved", "declined"],
  approved: ["linked_to_sale"],
  declined: [],
  linked_to_sale: [],
};

export type CardAttemptEvent =
  | { state: "uncertain" }
  | {
      state: "approved";
      providerReference: string;
      approvalCode: string;
      approvedAt: number;
    }
  | { state: "declined"; providerReference: string; verifiedByUserId: string }
  | {
      state: "linked_to_sale";
      providerReference: string;
      saleCommandId: string;
    };

type DeviceKey = { sign: <T>(payload: T, purpose: "command") => Signed<T> };

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hex64 = /^[a-f0-9]{64}$/;

/** Trimmed, bounded free text that cannot carry a full card number. */
function evidenceText(value: string, max: number): string {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > max ||
    value.trim() !== value
  )
    throw new Error("INVALID_RECORD");
  if (containsCardNumber(value)) throw new Error("CARD_NUMBER_IN_TEXT");
  return value;
}

export class OfflineSupportRecordWriter {
  constructor(
    private readonly deps: {
      db: PosDatabase;
      now?: () => Date;
    },
  ) {}

  private nowMs(): number {
    return (this.deps.now ?? (() => new Date()))().getTime();
  }

  /**
   * A note on an offline sale: what went wrong or what the customer said. Append-only, for online
   * review; it never changes the sale, stock, cash or a payment.
   */
  recordSaleIncident(input: {
    key: DeviceKey;
    staffSignInId: string;
    saleCommandId: string;
    category: OfflineSaleIncident["category"];
    description: string;
  }): Signed<OfflineSaleIncident> {
    if (!SALE_INCIDENT_CATEGORIES.includes(input.category))
      throw new Error("INVALID_RECORD");
    const description = evidenceText(
      input.description,
      MAX_INCIDENT_DESCRIPTION_LENGTH,
    );
    return this.write((ctx) => {
      const signIn = this.signInFor(ctx.enrollmentId, input.staffSignInId, ctx);
      if (!this.readSale(ctx.enrollmentId, input.saleCommandId))
        throw new Error("UNKNOWN_SALE");
      const payload: OfflineSaleIncident = {
        contractVersion: 1,
        kind: "sale_incident",
        recordId: randomUUID(),
        identity: ctx.identity,
        saleCommandId: input.saleCommandId,
        recordedByUserId: signIn.session.staffUserId,
        staffSignInId: signIn.staffSignInId,
        workSessionId: signIn.session.workSessionId,
        recordedAt: ctx.now,
        category: input.category,
        description,
      };
      return { payload, attemptId: null, cardState: null };
    }, input.key);
  }

  /**
   * Persists a new external-card attempt as `prepared`, before the card machine is asked to charge.
   * Refused unless the signed grant permits external card, and while another attempt for the same
   * checkout draft has not been settled: the first charge may have gone through, so there is never
   * an automatic second one.
   */
  prepareCardAttempt(input: {
    key: DeviceKey;
    staffSignInId: string;
    checkoutDraftId: string;
    reviewedSaleDigest: string;
    amountMinor: number;
  }): Signed<ExternalCardAttemptRecord> {
    if (
      !uuidPattern.test(input.checkoutDraftId) ||
      !hex64.test(input.reviewedSaleDigest) ||
      !Number.isSafeInteger(input.amountMinor) ||
      input.amountMinor < 1
    )
      throw new Error("INVALID_RECORD");
    return this.write((ctx) => {
      if (!ctx.grant.externalCardAllowed)
        throw new Error("EXTERNAL_CARD_NOT_ALLOWED");
      const signIn = this.signInFor(ctx.enrollmentId, input.staffSignInId, ctx);
      for (const attempt of this.attempts(ctx.enrollmentId))
        if (
          attempt.latest.checkoutDraftId === input.checkoutDraftId &&
          NEXT_CARD_STATES[attempt.latest.state].length > 0
        )
          throw new Error("ATTEMPT_UNRESOLVED");
      const payload: ExternalCardAttemptRecord = {
        contractVersion: 1,
        kind: "external_card_attempt",
        recordId: randomUUID(),
        identity: ctx.identity,
        attemptId: randomUUID(),
        checkoutDraftId: input.checkoutDraftId,
        reviewedSaleDigest: input.reviewedSaleDigest,
        amountMinor: input.amountMinor,
        staffSignInId: signIn.staffSignInId,
        workSessionId: signIn.session.workSessionId,
        recordedAt: ctx.now,
        state: "prepared",
      };
      return {
        payload,
        attemptId: payload.attemptId,
        cardState: "prepared" as const,
      };
    }, input.key);
  }

  /**
   * The next event of an existing attempt: uncertain, approved, declined, or linked to the sale it
   * paid for. The attempt's draft, digest and amount come from its first event, and a provider
   * reference or approval, once recorded, can't differ in a later one.
   */
  recordCardAttemptEvent(input: {
    key: DeviceKey;
    attemptId: string;
    staffSignInId: string;
    event: CardAttemptEvent;
  }): Signed<ExternalCardAttemptRecord> {
    const { event } = input;
    if (!uuidPattern.test(input.attemptId)) throw new Error("INVALID_RECORD");
    if (event.state === "approved") {
      evidenceText(event.providerReference, MAX_PROVIDER_REFERENCE_LENGTH);
      evidenceText(event.approvalCode, MAX_APPROVAL_CODE_LENGTH);
      if (!Number.isSafeInteger(event.approvedAt) || event.approvedAt < 0)
        throw new Error("INVALID_RECORD");
    } else if (event.state === "declined") {
      evidenceText(event.providerReference, MAX_PROVIDER_REFERENCE_LENGTH);
      if (!uuidPattern.test(event.verifiedByUserId))
        throw new Error("INVALID_RECORD");
    } else if (event.state === "linked_to_sale") {
      evidenceText(event.providerReference, MAX_PROVIDER_REFERENCE_LENGTH);
      if (!uuidPattern.test(event.saleCommandId))
        throw new Error("INVALID_RECORD");
    } else if (event.state !== "uncertain") throw new Error("INVALID_RECORD");
    return this.write((ctx) => {
      const attempt = this.attempts(ctx.enrollmentId).find(
        (a) => a.attemptId === input.attemptId,
      );
      if (!attempt) throw new Error("UNKNOWN_ATTEMPT");
      if (!NEXT_CARD_STATES[attempt.latest.state].includes(event.state))
        throw new Error("INVALID_TRANSITION");
      const signIn = this.signInFor(ctx.enrollmentId, input.staffSignInId, ctx);
      const first = attempt.events[0]!;
      const bound = {
        contractVersion: 1 as const,
        kind: "external_card_attempt" as const,
        recordId: randomUUID(),
        identity: ctx.identity,
        attemptId: attempt.attemptId,
        checkoutDraftId: first.checkoutDraftId,
        reviewedSaleDigest: first.reviewedSaleDigest,
        amountMinor: first.amountMinor,
        staffSignInId: signIn.staffSignInId,
        workSessionId: signIn.session.workSessionId,
        recordedAt: ctx.now,
      };
      const reference = attempt.events
        .map((e) => ("providerReference" in e ? e.providerReference : null))
        .find((r): r is string => r !== null);
      if (
        "providerReference" in event &&
        reference !== undefined &&
        event.providerReference !== reference
      )
        throw new Error("ATTEMPT_MISMATCH");
      let payload: ExternalCardAttemptRecord;
      switch (event.state) {
        case "uncertain":
          payload = { ...bound, state: "uncertain" };
          break;
        case "approved":
          // The card machine approved before this event was recorded.
          if (event.approvedAt > ctx.now) throw new Error("INVALID_RECORD");
          payload = {
            ...bound,
            state: "approved",
            providerReference: event.providerReference,
            approvalCode: event.approvalCode,
            approvedAt: event.approvedAt,
          };
          break;
        case "declined":
          // The person who checked the original card-machine result must be prepared on this counter.
          if (
            !ctx.grant.authorizedStaff.some(
              (s) => s.staffUserId === event.verifiedByUserId,
            )
          )
            throw new Error("STAFF_NOT_AUTHORIZED");
          payload = {
            ...bound,
            state: "declined",
            providerReference: event.providerReference,
            verifiedByUserId: event.verifiedByUserId,
          };
          break;
        case "linked_to_sale": {
          const approval = attempt.events.find((e) => e.state === "approved");
          const sale = this.readSale(ctx.enrollmentId, event.saleCommandId);
          // The sale must hold the very card payment this attempt approved.
          const paid =
            approval?.state === "approved" &&
            sale?.payments.some(
              (p) =>
                p.method === "external_card" &&
                p.providerReference === event.providerReference &&
                p.approvalCode === approval.approvalCode,
            );
          if (!sale) throw new Error("UNKNOWN_SALE");
          if (!paid) throw new Error("SALE_PAYMENT_MISMATCH");
          payload = {
            ...bound,
            state: "linked_to_sale",
            providerReference: event.providerReference,
            saleCommandId: event.saleCommandId,
          };
          break;
        }
      }
      return {
        payload,
        attemptId: attempt.attemptId,
        cardState: payload.state,
      };
    }, input.key);
  }

  /** Every attempt written here, each with its events in order; the latest is where it stands. */
  private attempts(enrollmentId: string): {
    attemptId: string;
    events: ExternalCardAttemptRecord[];
    latest: ExternalCardAttemptRecord;
  }[] {
    const rows = this.deps.db
      .prepare(
        `SELECT attempt_id, envelope_json FROM offline_support_record
         WHERE enrollment_id = ? AND kind = 'external_card_attempt' ORDER BY rowid`,
      )
      .all(enrollmentId) as { attempt_id: string; envelope_json: string }[];
    const byAttempt = new Map<string, ExternalCardAttemptRecord[]>();
    for (const row of rows) {
      const events = byAttempt.get(row.attempt_id) ?? [];
      events.push(
        (JSON.parse(row.envelope_json) as Signed<ExternalCardAttemptRecord>)
          .payload,
      );
      byAttempt.set(row.attempt_id, events);
    }
    return [...byAttempt].map(([attemptId, events]) => ({
      attemptId,
      events,
      latest: events[events.length - 1]!,
    }));
  }

  private readSale(
    enrollmentId: string,
    commandId: string,
  ): OfflineSaleCommand | null {
    const row = this.deps.db
      .prepare(
        "SELECT envelope_json FROM offline_journal_command WHERE enrollment_id = ? AND command_id = ?",
      )
      .get(enrollmentId, commandId) as { envelope_json: string } | undefined;
    if (!row) return null;
    const command = (
      JSON.parse(row.envelope_json) as Signed<OfflineJournalCommand>
    ).payload;
    return command.kind === "ordinary_sale" ? command : null;
  }

  /** The sign-in a record cites: this counter's, held here, and no later than the record. */
  private signInFor(
    enrollmentId: string,
    staffSignInId: string,
    ctx: { now: number },
  ): OfflineStaffSignIn {
    const row = this.deps.db
      .prepare(
        "SELECT envelope_json FROM offline_journal_staff_sign_in WHERE enrollment_id = ? AND staff_sign_in_id = ?",
      )
      .get(enrollmentId, staffSignInId) as
      | { envelope_json: string }
      | undefined;
    if (!row) throw new Error("UNKNOWN_SIGN_IN");
    const signIn = (JSON.parse(row.envelope_json) as Signed<OfflineStaffSignIn>)
      .payload;
    if (signIn.authenticatedAt > ctx.now) throw new Error("INVALID_RECORD");
    return signIn;
  }

  /**
   * Runs `build` against this counter's trusted state and, if it yields a record, signs and stores
   * it in one transaction. Nothing is stored when any check fails.
   */
  private write<T extends OfflineSaleIncident | ExternalCardAttemptRecord>(
    build: (ctx: WriteContext) => {
      payload: T;
      attemptId: string | null;
      cardState: CardState | null;
    },
    key: DeviceKey,
  ): Signed<T> {
    const db = this.deps.db;
    return db
      .transaction((): Signed<T> => {
        const device = readEnrolledDevice(db);
        if (!device) throw new Error("NO_DEVICE_KEY");
        const enrollmentId = device.enrollmentId;
        if (storeRestoreBlocksOffline(db, enrollmentId))
          throw new Error("RECONCILIATION_REQUIRED");
        const installed = readInstalledOfflineAuthority(db, enrollmentId);
        if (!installed) throw new Error("NO_OFFLINE_AUTHORITY");
        const grant = installed.grant.payload;
        const now = this.nowMs();
        if (now >= grant.expiresAt || now < grant.notBefore)
          throw new Error("GRANT_EXPIRED");
        const { publicKeyHex, ...identity } = device;
        const built = build({ enrollmentId, identity, grant, now });
        const envelope = key.sign(built.payload, "command");
        verifyDeviceCommandSignature(envelope, publicKeyHex);
        if (
          envelope.keyId !== identity.keyId ||
          !sameTerminalIdentity(built.payload.identity, identity)
        )
          throw new Error("IDENTITY_MISMATCH");
        const at = new Date(now).toISOString();
        db.prepare(
          `INSERT INTO offline_support_record
             (record_id, enrollment_id, kind, attempt_id, card_state, record_hash, envelope_json,
              recorded_at, sync_status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        ).run(
          built.payload.recordId,
          enrollmentId,
          built.payload.kind,
          built.attemptId,
          built.cardState,
          journalCommandHash(built.payload),
          JSON.stringify(envelope),
          built.payload.recordedAt,
          at,
        );
        return envelope;
      })
      .immediate();
  }
}

type WriteContext = {
  enrollmentId: string;
  identity: OfflineSaleIncident["identity"];
  grant: OfflineGrant;
  now: number;
};
