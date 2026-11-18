import type { Migration } from "../migrator";

/**
 * P4 #50, D8: a prepared manager's after-hours acknowledgement is a signed support record kept
 * here until the server holds it, like a sale note or a card attempt, so the table takes a third
 * kind. SQLite can't widen a CHECK in place, so the table is rebuilt as 0025 did: same columns,
 * rows (rowid included), indexes and triggers.
 */
export const hoursAcknowledgements: Migration = {
  version: 27,
  name: "hours-acknowledgements",
  up(db) {
    db.exec(`
      DROP TRIGGER offline_support_record_kept;
      DROP TRIGGER offline_support_record_signed;
      CREATE TABLE offline_support_record_new (
        record_id             TEXT PRIMARY KEY,
        enrollment_id         TEXT NOT NULL,
        kind                  TEXT NOT NULL CHECK (kind IN ('sale_incident', 'external_card_attempt', 'business_hours_acknowledgement')),
        attempt_id            TEXT,
        card_state            TEXT CHECK (
          card_state IS NULL OR card_state IN ('prepared', 'uncertain', 'approved', 'declined', 'linked_to_sale', 'not_used')
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
      -- rowid order is "which event came last" for an attempt, so it is carried over as it was.
      INSERT INTO offline_support_record_new (rowid, record_id, enrollment_id, kind, attempt_id, card_state,
        record_hash, envelope_json, recorded_at, sync_status, acknowledgement_json, acknowledged_at,
        last_error_code, created_at)
      SELECT rowid, record_id, enrollment_id, kind, attempt_id, card_state, record_hash, envelope_json,
        recorded_at, sync_status, acknowledgement_json, acknowledged_at, last_error_code, created_at
      FROM offline_support_record;
      DROP TABLE offline_support_record;
      ALTER TABLE offline_support_record_new RENAME TO offline_support_record;
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
