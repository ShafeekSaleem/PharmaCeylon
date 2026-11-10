import { Prisma } from "@prisma/client";
import type { CounterJournalSyncView } from "@pharmaceylon/shared";

/**
 * The accepted head of enrollment `e`'s offline journal: its highest sequenced command receipt,
 * or 0. Entries are accepted only at head + 1, so everything up to it is on the server. Reads
 * the `(tenant_id, enrollment_id, offline_sequence)` unique index backwards: one row per call.
 */
export const acceptedHeadSql = Prisma.sql`COALESCE((
  SELECT r.offline_sequence FROM terminal_command_receipt r
  WHERE r.tenant_id = e.tenant_id AND r.branch_id = e.branch_id AND r.enrollment_id = e.id
    AND r.offline_sequence IS NOT NULL
  ORDER BY r.offline_sequence DESC LIMIT 1), 0)`;

/**
 * Retained refusals of enrollment `e`'s commands past `head`, which will never be accepted as
 * sent: rejected by policy, or conflicting with the accepted chain. The same rule as the
 * issuance's `RECONCILIATION_REQUIRED` (slice 3): held entries are repairable by the counter.
 */
export const needsReviewPastHeadSql = (head: Prisma.Sql) => Prisma.sql`
  v.tenant_id = e.tenant_id AND v.branch_id = e.branch_id AND v.enrollment_id = e.id
  AND v.record_kind = 'command' AND v.outcome IN ('rejected', 'conflict') AND v.sequence > ${head}`;

/** One enrollment at the branch, as the status query returns it. */
export type JournalStatusRow = {
  enrollment_id: string;
  terminal_id: string;
  terminal_label: string;
  register_id: string | null;
  revoked_at: Date | null;
  retired_at: Date | null;
  head_sequence: bigint | number | null;
  head_accepted_at: Date | null;
  last_upload_at: Date | null;
  waiting: number;
  needs_review: number;
  stuck_sequence: bigint | number | null;
  stuck_outcome: string | null;
  stuck_error_code: string | null;
  stuck_since: Date | null;
  open_stock_cases: number;
};

/**
 * Every enrollment at the branch with its journal's head, last upload, the refused entries past
 * the head (counted once per sequence: rejected or conflicting if any copy was, else held) and
 * its open stock cases. Tenant and branch scope every table read.
 */
export function journalStatusQuery(
  tenantId: string,
  branchId: string,
): Prisma.Sql {
  const head = Prisma.sql`COALESCE(h.offline_sequence, 0)`;
  return Prisma.sql`
    SELECT e.id AS enrollment_id, e.terminal_id, t.label AS terminal_label, t.register_id,
      e.revoked_at, t.retired_at,
      h.offline_sequence AS head_sequence, h.recorded_at AS head_accepted_at,
      GREATEST(h.recorded_at,
        (SELECT max(v.last_received_at) FROM offline_journal_review v
          WHERE v.tenant_id = e.tenant_id AND v.branch_id = e.branch_id AND v.enrollment_id = e.id),
        (SELECT max(s.received_at) FROM offline_staff_sign_in s
          WHERE s.tenant_id = e.tenant_id AND s.branch_id = e.branch_id AND s.enrollment_id = e.id)
      ) AS last_upload_at,
      COALESCE(p.waiting, 0)::int AS waiting, COALESCE(p.needs_review, 0)::int AS needs_review,
      x.sequence AS stuck_sequence, x.outcome AS stuck_outcome, x.error_code AS stuck_error_code,
      x.first_received_at AS stuck_since,
      (SELECT count(*)::int FROM offline_stock_discrepancy c
        WHERE c.tenant_id = e.tenant_id AND c.branch_id = e.branch_id AND c.enrollment_id = e.id
          AND c.status = 'open') AS open_stock_cases
    FROM terminal_enrollment e
    JOIN operational_terminal t ON t.tenant_id = e.tenant_id AND t.branch_id = e.branch_id AND t.id = e.terminal_id
    LEFT JOIN LATERAL (
      SELECT r.offline_sequence, r.recorded_at FROM terminal_command_receipt r
      WHERE r.tenant_id = e.tenant_id AND r.branch_id = e.branch_id AND r.enrollment_id = e.id
        AND r.offline_sequence IS NOT NULL
      ORDER BY r.offline_sequence DESC LIMIT 1
    ) h ON true
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE NOT q.review) AS waiting, count(*) FILTER (WHERE q.review) AS needs_review
      FROM (
        SELECT v.sequence, bool_or(v.outcome IN ('rejected', 'conflict')) AS review
        FROM offline_journal_review v
        WHERE v.tenant_id = e.tenant_id AND v.branch_id = e.branch_id AND v.enrollment_id = e.id
          AND v.record_kind = 'command' AND v.sequence > ${head}
        GROUP BY v.sequence
      ) q
    ) p ON true
    LEFT JOIN LATERAL (
      SELECT v.sequence, v.outcome, v.error_code, v.first_received_at FROM offline_journal_review v
      WHERE ${needsReviewPastHeadSql(head)}
      ORDER BY v.sequence, v.first_received_at LIMIT 1
    ) x ON true
    WHERE e.tenant_id = ${tenantId}::uuid AND e.branch_id = ${branchId}::uuid
    ORDER BY e.created_at DESC, e.id`;
}

const time = (value: Date | null) => (value ? value.getTime() : null);

export function journalSyncView(row: JournalStatusRow): CounterJournalSyncView {
  const revokedAt = time(row.revoked_at);
  const retiredAt = time(row.retired_at);
  return {
    enrollmentId: row.enrollment_id,
    terminalId: row.terminal_id,
    terminalLabel: row.terminal_label,
    registerId: row.register_id,
    current: revokedAt === null && retiredAt === null,
    revokedAt,
    retiredAt,
    head:
      row.head_sequence === null || !row.head_accepted_at
        ? null
        : {
            sequence: Number(row.head_sequence),
            acceptedAt: row.head_accepted_at.getTime(),
          },
    lastUploadAt: time(row.last_upload_at),
    waiting: Number(row.waiting),
    needsReview: Number(row.needs_review),
    stuck:
      row.stuck_sequence === null || !row.stuck_since
        ? null
        : {
            sequence: Number(row.stuck_sequence),
            outcome: row.stuck_outcome === "conflict" ? "conflict" : "rejected",
            errorCode: row.stuck_error_code ?? "",
            since: row.stuck_since.getTime(),
          },
    openStockCases: Number(row.open_stock_cases),
  };
}

/** Whether anything from this enrollment is still short of settled on the server. */
export function hasOutstanding(view: CounterJournalSyncView): boolean {
  return view.waiting > 0 || view.needsReview > 0 || view.openStockCases > 0;
}

/**
 * What a manager needs to see: each counter's current enrollment, plus any earlier one (a
 * revoked key, a retired computer) that still has entries waiting or stock cases open. An old
 * enrollment that left nothing behind is history, not status.
 */
export function journalSyncViews(
  rows: readonly JournalStatusRow[],
): CounterJournalSyncView[] {
  return rows
    .map(journalSyncView)
    .filter((view) => view.current || hasOutstanding(view));
}
