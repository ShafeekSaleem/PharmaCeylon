import { Prisma } from "@prisma/client";
import { SUPPORT_MANAGER_HELD_REASONS } from "../terminals/support-queue-predicates";

/** Same cap as `SalesQueuesService.paymentRecovery` / `SupportEvidenceReconciler.listHeld`. */
export const PAYMENT_RECOVERY_WORK_ROW_CAP = 500;

const managerHeldReasons = Prisma.join([...SUPPORT_MANAGER_HELD_REASONS]);

/**
 * Daily-work SQL sources for W4 sales recovery queues. Predicates match
 * `incidentNotesWhere`, `paymentRecoveryWhere`, and `OfflineCollectedPayment` scope in
 * `SalesQueuesService` so managers see the same rows in Daily work and Sales tabs.
 */
export function saleIncidentWorkSource(tenantId: string, branchId: string): Prisma.Sql {
  return Prisma.sql`
    SELECT 'incident:' || r.record_id::text AS id,
      'sale_incident.review' AS kind,
      'counter' AS category,
      CASE WHEN r.status = 'held' THEN 'Review held incident note' ELSE 'Review incident note' END AS title,
      concat_ws(' · ', COALESCE(t.label, 'Counter'), NULLIF(r.incident_category, ''), NULLIF(left(r.description, 120), '')) AS detail,
      r.record_id::text AS reference,
      r.status::text AS status,
      '/sales?view=incident-notes&recordId=' || r.record_id::text
        || CASE WHEN r.status = 'held' THEN '&status=held' ELSE '' END AS href,
      'Open in Sales' AS action,
      r.recorded_at AS created_at,
      NULL::timestamp AS due_at,
      'Branch managers' AS owner,
      false AS mine,
      false AS approval,
      false AS blocked,
      CASE WHEN r.status = 'held' THEN 0 ELSE 1 END AS priority
    FROM offline_support_record r
      LEFT JOIN operational_terminal t
        ON t.tenant_id = r.tenant_id AND t.branch_id = r.branch_id AND t.id = r.terminal_id
    WHERE r.tenant_id = ${tenantId}::uuid AND r.branch_id = ${branchId}::uuid
      AND r.kind = 'sale_incident'
      AND (
        r.status = 'accepted'
        OR (r.status = 'held' AND r.held_reason IN (${managerHeldReasons}))
      )`;
}

export function paymentRecoveryWorkSource(tenantId: string, branchId: string): Prisma.Sql {
  return Prisma.sql`
    SELECT 'payment_recovery:' || l.attempt_id::text AS id,
      'payment_recovery.review' AS kind,
      'counter' AS category,
      'Review card payment recovery' AS title,
      concat_ws(' · ', COALESCE(t.label, 'Counter'), COALESCE(l.held_reason, 'held'), l.provider_reference) AS detail,
      l.attempt_id::text AS reference,
      'held' AS status,
      '/sales?view=payment-recovery&attemptId=' || l.attempt_id::text AS href,
      'Open in Sales' AS action,
      l.recorded_at AS created_at,
      NULL::timestamp AS due_at,
      'Branch managers' AS owner,
      false AS mine,
      false AS approval,
      false AS blocked,
      0 AS priority
    FROM (
      SELECT DISTINCT ON (c.attempt_id) c.*
      FROM (
        SELECT *
        FROM offline_support_record
        WHERE tenant_id = ${tenantId}::uuid AND branch_id = ${branchId}::uuid
          AND kind = 'external_card_attempt' AND status = 'held'
          AND held_reason IN (${managerHeldReasons})
          AND attempt_id IS NOT NULL
        ORDER BY received_at DESC
        LIMIT ${PAYMENT_RECOVERY_WORK_ROW_CAP}
      ) c
      ORDER BY c.attempt_id, c.received_at DESC
    ) l
      LEFT JOIN operational_terminal t
        ON t.tenant_id = l.tenant_id AND t.branch_id = l.branch_id AND t.id = l.terminal_id`;
}

export function collectedMoneyWorkSource(tenantId: string, branchId: string): Prisma.Sql {
  return Prisma.sql`
    SELECT 'collected_money:' || p.id::text AS id,
      'collected_money.review' AS kind,
      'counter' AS category,
      'Resolve collected card money' AS title,
      concat_ws(' · ', COALESCE(u.full_name, 'Staff'), p.provider_reference,
        'LKR ' || (p.amount_minor::numeric / 100)::text) AS detail,
      COALESCE(p.provider_reference, p.id::text) AS reference,
      'unresolved' AS status,
      '/sales?view=unresolved-money&paymentId=' || p.id::text AS href,
      'Open in Sales' AS action,
      p.collected_at AS created_at,
      NULL::timestamp AS due_at,
      'Branch managers' AS owner,
      false AS mine,
      false AS approval,
      false AS blocked,
      0 AS priority
    FROM offline_collected_payment p
      LEFT JOIN app_user u ON u.id = p.staff_user_id
    WHERE p.tenant_id = ${tenantId}::uuid AND p.branch_id = ${branchId}::uuid`;
}