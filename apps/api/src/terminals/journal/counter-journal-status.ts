import { Prisma } from "@prisma/client";
import type { CounterJournalSyncView } from "@pharmaceylon/shared";

/**
 * The enrollments at one branch, `e`, with their computer `t`. Every other table these queries
 * read is joined on `e.tenant_id` and `e.branch_id`, so this is the only place the caller's
 * tenant and branch are bound.
 */
const enrollmentsAt = (tenantId: string, branchId: string) => ({
  from: Prisma.sql`FROM terminal_enrollment e
    JOIN operational_terminal t ON t.tenant_id = e.tenant_id AND t.branch_id = e.branch_id AND t.id = e.terminal_id`,
  where: Prisma.sql`e.tenant_id = ${tenantId}::uuid AND e.branch_id = ${branchId}::uuid`,
});

/**
 * Joins `h`: enrollment `e`'s accepted head, its highest sequenced command receipt (no row while
 * nothing has been accepted). Entries are accepted only at head + 1, so everything up to it is on
 * the server. Reads the `(tenant_id, enrollment_id, offline_sequence)` unique index backwards.
 */
export const acceptedHeadJoin = Prisma.sql`LEFT JOIN LATERAL (
    SELECT r.offline_sequence, r.recorded_at FROM terminal_command_receipt r
    WHERE r.tenant_id = e.tenant_id AND r.branch_id = e.branch_id AND r.enrollment_id = e.id
      AND r.offline_sequence IS NOT NULL
    ORDER BY r.offline_sequence DESC LIMIT 1
  ) h ON true`;

/**
 * Joins `x` (after `h`): where `e`'s journal stopped, the lowest sequence past the head with a
 * retained refusal, most severe copy first (conflict, rejected, held). A command is judged only at
 * head + 1 and the head never moves back, so a rejected or conflicting entry past the head is
 * always this one: `x.outcome IN ('rejected', 'conflict')` is the issuance's
 * `RECONCILIATION_REQUIRED` rule (slice 3's `journalAwaitingReview`). Intake stops at the first
 * refusal, so the server holds nothing after it and can't tell how many entries follow.
 */
export const stoppedAtJoin = Prisma.sql`LEFT JOIN LATERAL (
    SELECT v.sequence, v.outcome, v.error_code, v.first_received_at FROM offline_journal_review v
    WHERE v.tenant_id = e.tenant_id AND v.branch_id = e.branch_id AND v.enrollment_id = e.id
      AND v.record_kind = 'command' AND v.sequence > COALESCE(h.offline_sequence, 0)
    ORDER BY v.sequence, CASE v.outcome WHEN 'conflict' THEN 0 WHEN 'rejected' THEN 1 ELSE 2 END,
      v.first_received_at
    LIMIT 1
  ) x ON true`;

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
  last_received_at: Date | null;
  stopped_sequence: bigint | number | null;
  stopped_outcome: string | null;
  stopped_error_code: string | null;
  stopped_since: Date | null;
  open_stock_cases: number;
};

/**
 * Every enrollment at the branch with its journal's head, the last time an upload brought
 * something, where it stopped, and its open stock cases. One statement, so one snapshot.
 */
export function journalStatusQuery(
  tenantId: string,
  branchId: string,
): Prisma.Sql {
  const scope = enrollmentsAt(tenantId, branchId);
  return Prisma.sql`
    SELECT e.id AS enrollment_id, e.terminal_id, t.label AS terminal_label, t.register_id,
      e.revoked_at, t.retired_at,
      h.offline_sequence AS head_sequence, h.recorded_at AS head_accepted_at,
      GREATEST(h.recorded_at,
        (SELECT max(v.last_received_at) FROM offline_journal_review v
          WHERE v.tenant_id = e.tenant_id AND v.branch_id = e.branch_id AND v.enrollment_id = e.id),
        (SELECT max(s.received_at) FROM offline_staff_sign_in s
          WHERE s.tenant_id = e.tenant_id AND s.branch_id = e.branch_id AND s.enrollment_id = e.id)
      ) AS last_received_at,
      x.sequence AS stopped_sequence, x.outcome AS stopped_outcome, x.error_code AS stopped_error_code,
      x.first_received_at AS stopped_since,
      (SELECT count(*)::int FROM offline_stock_discrepancy c
        WHERE c.tenant_id = e.tenant_id AND c.branch_id = e.branch_id AND c.enrollment_id = e.id
          AND c.status = 'open') AS open_stock_cases
    ${scope.from}
    ${acceptedHeadJoin}
    ${stoppedAtJoin}
    WHERE ${scope.where}
    ORDER BY e.created_at DESC, e.id`;
}

/**
 * Daily work's `offline_journal.review` source: a current counter (key not revoked, computer not
 * retired) whose journal stopped on a rejected entry. Slice 4 (#155) settles exactly these: its
 * settlement writes the receipt at that sequence, the head moves past it and the item drops out.
 * Conflicts and revoked or retired counters are left to D11 journal recovery (#154) and are not
 * listed: nothing here clears them. The Counters page still shows them.
 *
 * TODO(#155): once slice 4 is in `develop`, link `/inventory/offline-records` instead of the
 * Counters page (and gate the source on `sales.review_offline_entries` in daily-work.service).
 */
export function stuckJournalWorkSource(
  tenantId: string,
  branchId: string,
): Prisma.Sql {
  const scope = enrollmentsAt(tenantId, branchId);
  return Prisma.sql`
    SELECT 'journal:' || e.id, 'offline_journal.review', 'counter', 'Review refused offline entry',
      concat(COALESCE(k.label, t.label), ' · stopped at entry ', x.sequence, '; nothing after it syncs'),
      t.label, x.error_code, '/settings/counters', 'Open counters', x.first_received_at, NULL::timestamp,
      'Branch managers', false, false, false, 1
    ${scope.from}
    LEFT JOIN terminal_counter k ON k.tenant_id = e.tenant_id AND k.branch_id = e.branch_id AND k.id = t.register_id
    ${acceptedHeadJoin}
    ${stoppedAtJoin}
    WHERE ${scope.where} AND e.revoked_at IS NULL AND t.retired_at IS NULL AND x.outcome = 'rejected'`;
}

const time = (value: Date | null) => (value ? value.getTime() : null);
const OUTCOMES = ["held", "rejected", "conflict"] as const;

export function journalSyncView(row: JournalStatusRow): CounterJournalSyncView {
  const revokedAt = time(row.revoked_at);
  const retiredAt = time(row.retired_at);
  const outcome = OUTCOMES.find((o) => o === row.stopped_outcome);
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
    lastReceivedAt: time(row.last_received_at),
    stoppedAt:
      row.stopped_sequence === null || !row.stopped_since || !outcome
        ? null
        : {
            sequence: Number(row.stopped_sequence),
            outcome,
            errorCode: row.stopped_error_code ?? "",
            since: row.stopped_since.getTime(),
          },
    openStockCases: Number(row.open_stock_cases),
  };
}

/** Whether anything from this enrollment is still short of settled on the server. */
export function hasOutstanding(view: CounterJournalSyncView): boolean {
  return view.stoppedAt !== null || view.openStockCases > 0;
}

/**
 * What a manager needs to see: each counter's current enrollment, plus any earlier one (a
 * revoked key, a retired computer) whose journal stopped short or has stock cases open. An old
 * enrollment that left nothing behind is history, not status.
 */
export function journalSyncViews(
  rows: readonly JournalStatusRow[],
): CounterJournalSyncView[] {
  return rows
    .map(journalSyncView)
    .filter((view) => view.current || hasOutstanding(view));
}
