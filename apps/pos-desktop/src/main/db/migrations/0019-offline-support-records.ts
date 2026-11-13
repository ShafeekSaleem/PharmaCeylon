import type { Migration } from "../migrator";

/**
 * P4 #50: the counter's offline support records — sale-incident notes and external-card attempt
 * events (`OfflineSupportRecord`). They are an evidence stream apart from the journal: they take no
 * journal sequence, never post a sale, payment, stock or cash effect, and authorize nothing.
 *
 * Each row keeps the device-signed envelope exactly as it was signed (`envelope_json`) and its
 * SHA-256 (`record_hash`), which the server's acknowledgement must name. Nothing is deleted and the
 * signed content never changes; only the upload bookkeeping at the end of the row moves.
 *
 * `sync_status` is this computer's view of the server's reply:
 * - `pending`: not acknowledged yet (never sent, or sent and answered with a retryable refusal).
 * - `received`: the server holds it durably. For incidents and card attempts that is always "kept
 *   for review": the server never marks them accepted, because the sale and the card machine's
 *   result are checked online by a person.
 * - `refused`: the server already holds other content under this record ID (`REPLAY_CONFLICT`).
 *   Resending the same bytes can't change that; it needs repair, so it is never resent.
 *
 * A card attempt is one row per state change; several rows share an `attempt_id`, and the latest by
 * `rowid` is where the attempt stands.
 */
export const offlineSupportRecords: Migration = {
  version: 19,
  name: "offline-support-records",
  up(db) {
    db.exec(`
      CREATE TABLE offline_support_record (
        record_id             TEXT PRIMARY KEY,
        enrollment_id         TEXT NOT NULL,
        kind                  TEXT NOT NULL CHECK (kind IN ('sale_incident', 'external_card_attempt')),
        attempt_id            TEXT,
        card_state            TEXT CHECK (
          card_state IS NULL OR card_state IN ('prepared', 'uncertain', 'approved', 'declined', 'linked_to_sale')
        ),
        record_hash           TEXT NOT NULL CHECK (length(record_hash) = 64),
        envelope_json         TEXT NOT NULL,
        recorded_at           INTEGER NOT NULL CHECK (recorded_at >= 0),
        sync_status           TEXT NOT NULL DEFAULT 'pending' CHECK (sync_status IN ('pending', 'received', 'refused')),
        acknowledgement_json  TEXT,
        acknowledged_at       TEXT,
        last_error_code       TEXT,
        created_at            TEXT NOT NULL,
        CHECK ((kind = 'external_card_attempt') = (attempt_id IS NOT NULL AND card_state IS NOT NULL)),
        CHECK ((sync_status = 'pending') = (acknowledged_at IS NULL))
      ) STRICT;
      CREATE INDEX offline_support_record_enrollment ON offline_support_record (enrollment_id, sync_status);
      CREATE INDEX offline_support_record_attempt ON offline_support_record (enrollment_id, attempt_id);

      CREATE TRIGGER offline_support_record_kept BEFORE DELETE ON offline_support_record
      BEGIN SELECT RAISE(ABORT, 'offline support records are kept'); END;
      CREATE TRIGGER offline_support_record_signed BEFORE UPDATE ON offline_support_record
      WHEN NEW.record_id IS NOT OLD.record_id OR NEW.enrollment_id IS NOT OLD.enrollment_id
        OR NEW.kind IS NOT OLD.kind OR NEW.attempt_id IS NOT OLD.attempt_id
        OR NEW.card_state IS NOT OLD.card_state OR NEW.record_hash IS NOT OLD.record_hash
        OR NEW.envelope_json IS NOT OLD.envelope_json OR NEW.recorded_at IS NOT OLD.recorded_at
      BEGIN SELECT RAISE(ABORT, 'a signed support record never changes'); END;
    `);
  },
};
