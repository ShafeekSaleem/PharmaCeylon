import {
  mayResumeOnlineCheckout,
  type OnlineCheckoutResumeEvidence,
} from "@pharmaceylon/shared";
import type { PosDatabase } from "../db/database";
import {
  activeOutage,
  journalCoverage,
  localJournalHead,
  refusedSupportRecords,
  undeliveredSupportRecords,
  unresolvedCardAttempts,
  type JournalPosition,
} from "./offline-journal";

/**
 * P5 #51, approved D12: the reconnect drain on the nominated counter, in local state.
 *
 * After an outage (P4 records its `offline_session_id`), the counter pauses new online
 * checkouts while it uploads its journal, resolves uncertain submissions and installs a fresh
 * snapshot rebased over the accepted journal, with the server's stock-review blocks. The outage
 * ends — and checkout resumes — only in the same transaction that installs that snapshot
 * (`installOfflineAuthority`), or when the server has refused this counter offline authority
 * altogether (`finishDrainWithoutRenewal`). A failed or partial upload, a restart or a network
 * flap changes none of this: the outage, its baseline and its timer stay as they were.
 *
 * Everything here reads or writes this computer's encrypted store; nothing is a renderer claim.
 */

/** Why a sale can't start here now. */
export type CheckoutSyncPause = {
  /** `draining`: an outage's drain hasn't finished. `unsynced`: journal entries the server hasn't accepted. */
  reason: "draining" | "unsynced";
  /** Journal entries recorded here that the server has not accepted yet. */
  waiting: number;
  outageStartedAt: number | null;
  /**
   * Online sales and signed actions sent from this enrollment with no confirmed outcome. The
   * drain waits for them, so staff are told what to confirm (zero when no outage is draining).
   */
  unconfirmed: Unconfirmed;
  /** Offline evidence records that hold the drain apart from the journal itself (P4 #50). */
  holds: DrainHolds;
};

export type Unconfirmed = { sales: number; actions: number };

/**
 * What else keeps an outage from finishing: card attempts not yet settled, support records the
 * server has not received, and support records it refused (those never clear by themselves).
 */
export type DrainHolds = { cards: number; records: number; refused: number };

export const NOTHING_UNCONFIRMED: Unconfirmed = Object.freeze({ sales: 0, actions: 0 });
export const NO_HOLDS: DrainHolds = Object.freeze({ cards: 0, records: 0, refused: 0 });

/** The evidence still holding an outage's drain, from the local store. */
export function drainHolds(db: PosDatabase, enrollmentId: string): DrainHolds {
  return {
    cards: unresolvedCardAttempts(db, enrollmentId),
    records: undeliveredSupportRecords(db, enrollmentId),
    refused: refusedSupportRecords(db, enrollmentId),
  };
}

type SyncRow = {
  accepted_through_sequence: number;
  accepted_through_hash: string | null;
};

/** The highest contiguous journal position the server has confirmed it accepted (signed evidence). */
export function readAcceptedWatermark(
  db: PosDatabase,
  enrollmentId: string,
): JournalPosition {
  const row = db
    .prepare(
      "SELECT accepted_through_sequence, accepted_through_hash FROM offline_journal_sync WHERE enrollment_id = ?",
    )
    .get(enrollmentId) as SyncRow | undefined;
  return row
    ? {
        sequence: row.accepted_through_sequence,
        hash: row.accepted_through_hash,
      }
    : { sequence: 0, hash: null };
}

/** Makes sure the enrollment has its sync row. Run inside the caller's transaction. */
export function ensureSyncRow(
  db: PosDatabase,
  enrollmentId: string,
  at: string,
): void {
  db.prepare(
    `INSERT INTO offline_journal_sync (enrollment_id, updated_at) VALUES (?, ?)
     ON CONFLICT (enrollment_id) DO NOTHING`,
  ).run(enrollmentId, at);
}

/**
 * Records a server-signed watermark that matches the local chain. It only moves forward: a
 * watermark is the server's durable acceptance, which never shrinks. Returns false (and records
 * nothing) when it doesn't match this computer's journal or would move backwards.
 */
export function recordAcceptedWatermark(
  db: PosDatabase,
  enrollmentId: string,
  watermark: JournalPosition,
  at: string,
): boolean {
  if (journalCoverage(db, enrollmentId, watermark) === "mismatch") return false;
  const current = readAcceptedWatermark(db, enrollmentId);
  if (watermark.sequence < current.sequence) return false;
  ensureSyncRow(db, enrollmentId, at);
  db.prepare(
    `UPDATE offline_journal_sync SET accepted_through_sequence = ?, accepted_through_hash = ?, updated_at = ?
     WHERE enrollment_id = ?`,
  ).run(watermark.sequence, watermark.hash, at, enrollmentId);
  return true;
}

/**
 * Online sales and signed actions sent from this enrollment without a confirmed outcome. Each one
 * can be confirmed here: a sale or action left by an earlier enrollment of this computer can't be
 * resent from this one (its sale is checked on the web instead), so it never holds this drain.
 * Drafts written before they recorded their enrollment can still be resent, so they count.
 */
export function unresolvedSubmissions(
  db: PosDatabase,
  enrollmentId: string,
): Unconfirmed {
  const sales = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM checkout_draft
         WHERE status IN ('submitted', 'uncertain') AND (enrollment_id IS NULL OR enrollment_id = ?)`,
      )
      .get(enrollmentId) as { n: number }
  ).n;
  // A signed command has no enrollment column; its signed envelope names the one it was sent from.
  const actions = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM signed_command
         WHERE status IN ('sent', 'uncertain')
           AND json_extract(envelope_json, '$.payload.identity.enrollmentId') = ?`,
      )
      .get(enrollmentId) as { n: number }
  ).n;
  return { sales, actions };
}

/**
 * The trusted local facts `mayResumeOnlineCheckout` needs (D12), with the fresh-snapshot facts
 * supplied by the caller: true only inside the transaction that installs a pair covering the
 * journal, whose snapshot carries the server's review blocks.
 *
 * Support records (P4 #50, `offline-support-records.ts`) must all have reached the server, and
 * every external-card attempt must be settled — declined, or linked to the sale it paid for — on
 * top of the online sales still unconfirmed. A refused support record (the server holds other
 * content under its ID) never clears by itself, so it holds the drain until repaired.
 */
export function drainResumeEvidence(
  db: PosDatabase,
  enrollmentId: string,
  fresh: { snapshotCoversJournal: boolean },
): OnlineCheckoutResumeEvidence {
  const head = localJournalHead(db, enrollmentId);
  const accepted = readAcceptedWatermark(db, enrollmentId);
  const unresolved = unresolvedSubmissions(db, enrollmentId);
  return {
    // The caller holds a server response to a signed-in counter session.
    authenticated: true,
    journalAcceptedThroughLastLocalCommand:
      accepted.sequence === head.sequence && accepted.hash === head.hash,
    uncertainCommandsResolved:
      unresolved.sales === 0 && unresolved.actions === 0,
    freshSnapshotInstalled: fresh.snapshotCoversJournal,
    stockReviewBlocksInstalled: fresh.snapshotCoversJournal,
    supportRecordsAccepted: undeliveredSupportRecords(db, enrollmentId) === 0,
    // An unconfirmed online sale is a payment that may or may not have been taken, and so is a
    // card attempt that is prepared, uncertain, or approved but not yet tied to a sale.
    paymentAttemptsResolved:
      unresolved.sales === 0 && unresolvedCardAttempts(db, enrollmentId) === 0,
  };
}

/** Ends the outage: the drain is complete. Run inside the caller's transaction. */
export function endOutage(
  db: PosDatabase,
  enrollmentId: string,
  at: string,
): void {
  const outage = activeOutage(db, enrollmentId);
  if (!outage) return;
  ensureSyncRow(db, enrollmentId, at);
  db.prepare(
    `UPDATE offline_journal_sync SET drained_outage_id = ?, drained_outage_started_at = ?, drained_at = ?, updated_at = ?
     WHERE enrollment_id = ?`,
  ).run(outage.offlineSessionId, outage.offlineStartedAt, at, at, enrollmentId);
  db.prepare(
    `UPDATE offline_journal_state SET offline_session_id = NULL, offline_started_at = NULL, updated_at = ?
     WHERE enrollment_id = ? AND offline_session_id = ?`,
  ).run(at, enrollmentId, outage.offlineSessionId);
}

/**
 * The drain's other ending: the server refuses this counter offline authority (it is no longer
 * the branch's offline counter, or offline selling is off), so no rebased snapshot will ever come.
 * Online checkout needs none — the server checks stock and its review blocks itself — so once the
 * whole journal is accepted and nothing sent is uncertain, the outage ends without one.
 *
 * The installed pair stays as it was, with its consumption: it is never renewed, its saved
 * stock is soon too old to start another outage on, and the server counts its grant as live
 * until it expires (D11 cutoff). Returns whether the outage ended.
 */
export function finishDrainWithoutRenewal(
  db: PosDatabase,
  enrollmentId: string,
  at: string,
): boolean {
  return db
    .transaction((): boolean => {
      // Everything D12 asks for but the fresh snapshot, which online checkout doesn't need: the
      // same rule the installer applies, so a condition P4 adds to it applies here too.
      if (!drainAwaitsFreshSnapshot(db, enrollmentId)) return false;
      endOutage(db, enrollmentId, at);
      return true;
    })
    .immediate();
}

/** Whether the drain can finish as soon as a fresh pair covering the journal is installed. */
export function drainAwaitsFreshSnapshot(
  db: PosDatabase,
  enrollmentId: string,
): boolean {
  if (!activeOutage(db, enrollmentId)) return false;
  const evidence = drainResumeEvidence(db, enrollmentId, {
    snapshotCoversJournal: true,
  });
  return mayResumeOnlineCheckout(evidence);
}

/**
 * Whether new online checkouts pause on this counter: while an outage's drain hasn't finished,
 * or while journal entries recorded here are not accepted by the server. Counters with no
 * offline journal are never paused. A paused counter may still confirm its unconfirmed sales —
 * resolving them is part of the drain.
 */
export function checkoutSyncPause(
  db: PosDatabase,
  enrollmentId: string,
): CheckoutSyncPause | null {
  const outage = activeOutage(db, enrollmentId);
  return syncPauseFrom(
    outage,
    localJournalHead(db, enrollmentId),
    readAcceptedWatermark(db, enrollmentId),
    outage ? unresolvedSubmissions(db, enrollmentId) : NOTHING_UNCONFIRMED,
    outage ? drainHolds(db, enrollmentId) : NO_HOLDS,
  );
}

/**
 * `checkoutSyncPause` from facts the caller has already read (the sync view polls every 3 s).
 * `unconfirmed` matters only while an outage drains: pass `NOTHING_UNCONFIRMED` otherwise.
 */
export function syncPauseFrom(
  outage: { offlineStartedAt: number } | null,
  head: JournalPosition,
  accepted: JournalPosition,
  unconfirmed: Unconfirmed,
  holds: DrainHolds = NO_HOLDS,
): CheckoutSyncPause | null {
  const waiting = Math.max(0, head.sequence - accepted.sequence);
  if (!outage && waiting === 0) return null;
  return {
    reason: outage ? "draining" : "unsynced",
    waiting,
    outageStartedAt: outage?.offlineStartedAt ?? null,
    unconfirmed: outage ? { ...unconfirmed } : { ...NOTHING_UNCONFIRMED },
    holds: outage ? { ...holds } : { ...NO_HOLDS },
  };
}

/**
 * Whether this computer's journal disagrees with the server's (`JOURNAL_MISMATCH` from a signed
 * reply): the server holds offline records from this enrollment that this computer lost or never
 * wrote, e.g. after restoring an old backup. No outage may start here until it is recovered
 * online: selling offline on a restored journal could reuse sequences or revive old authority.
 * Only a verified reply sets or clears it; a failed cycle leaves it in place (`recordFailure`).
 */
export function journalNeedsRecovery(
  db: PosDatabase,
  enrollmentId: string,
): boolean {
  const row = db
    .prepare(
      "SELECT issue_code FROM offline_journal_sync WHERE enrollment_id = ?",
    )
    .get(enrollmentId) as { issue_code: string | null } | undefined;
  return row?.issue_code === "JOURNAL_MISMATCH";
}
