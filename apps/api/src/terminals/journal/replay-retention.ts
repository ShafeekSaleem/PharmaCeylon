/**
 * P5 #51 item 11: the retention rule for the offline journal (POS_V1_OPERATIONAL_READINESS.md,
 * "Offline journal retention").
 *
 * A counter can send the same signed entry again at any time: after a lost response, after a
 * restore from backup, after its grant expired, after its key was revoked (recovery). The server's
 * answer to an identical replay must be the original receipt (`duplicate`), and to a changed one a
 * conflict, never a new business effect. That answer is read from the rows below, so none of them
 * may ever be purged by a TTL, an expiry, `auditLogRetentionDays` or any cleanup job while the
 * counter that wrote them could still send them, which in practice is forever: a journal file
 * outlives any key, grant or computer.
 *
 * Each table refuses DELETE with a row trigger in its migration; `offline-replay-retention.int-spec`
 * checks every table here still does, and that every `offline_*` table is listed here or in
 * `REPLAY_RETENTION_EXEMPT` with a reason. Expiry (`expires_at`) only ever stops a NEW command
 * being accepted; it never removes what was accepted.
 */
export const REPLAY_RETAINED_TABLES = {
  terminal_command_receipt:
    "The receipt itself, and the command-ID and per-enrollment sequence watermark (head) an identical replay is answered from.",
  terminal_enrollment: "The key a replay is verified against, also after it is revoked.",
  operational_terminal: "The computer an enrollment belongs to, also after it is retired.",
  offline_journal_review:
    "Held, rejected and conflicting uploads: a replay of a refused entry stays refused, and a changed copy is judged against it.",
  offline_journal_settlement: "A manager's settlement of a refused entry, which a replay must not redo.",
  offline_collected_payment: "Money recorded by a settlement.",
  offline_staff_sign_in: "The signed offline sign-ins replayed sales cite.",
  offline_authority_issuance: "The grant a replayed entry was made under, after it expires.",
  offline_stock_snapshot: "The signed prices and stock a replayed sale is validated against.",
  offline_stock_discrepancy: "Stock case evidence for a sale whose stock could not post.",
  offline_stock_discrepancy_line: "Stock case evidence, per batch.",
  offline_stock_resolution: "How a stock case was accounted for.",
  offline_stock_settlement: "Stock case settlement.",
  offline_stock_settlement_link: "Stock case settlement, per case.",
  batch_sale_block: "The batch block a stock case set; released, never deleted.",
  offline_journal_recovery: "D11 journal recovery and its sign-off.",
  offline_journal_recovery_entry: "Each entry a recovery matched or left as evidence.",
  offline_counter_restore: "A counter restored from backup, whose journal replays from there.",
  offline_support_record: "Support-record receipts (customers, prescriptions) from the counter.",
  offline_support_conflict: "Refused support-record copies.",
  offline_terminal_delegation: "Who could nominate the offline counter.",
  offline_terminal_assignment_authorization: "Each nomination's signed authorization.",
} as const;

/** `offline_*` tables that are not replay evidence, and why. */
export const REPLAY_RETENTION_EXEMPT = {
  offline_terminal_nomination:
    "The branch's current nomination pointer (one row, replaced on reassignment); every nomination's evidence is offline_terminal_assignment_authorization.",
} as const;
