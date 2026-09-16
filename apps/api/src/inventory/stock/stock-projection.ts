import { Prisma } from "@prisma/client";

type SqlClient = {
  $executeRaw: Prisma.TransactionClient["$executeRaw"];
  $queryRaw: Prisma.TransactionClient["$queryRaw"];
};

export type StockProjectionMismatch = {
  batchId: string;
  onHandQty: number;
  ledgerOnHand: number;
  quarantinedQty: number;
  ledgerQuarantined: number;
  reservedQty: number;
  activeReserved: number;
};

/**
 * Recompute `batch_stock` for a tenant straight from the ledger and active reservations.
 *
 * The app never needs this — `StockService` keeps the totals as it writes. It exists for
 * programs that write the ledger in bulk without the service (the demo seeds) and as the
 * reference the reconciliation check compares the live totals against.
 */
export async function rebuildBatchStock(client: SqlClient, tenantId: string): Promise<void> {
  await client.$executeRaw`
    INSERT INTO batch_stock (batch_id, tenant_id, branch_id, product_id, on_hand_qty, quarantined_qty, reserved_qty, updated_at)
    SELECT b.id, b.tenant_id, b.branch_id, b.product_id,
           COALESCE(led.on_hand, 0), COALESCE(led.quarantined, 0), COALESCE(res.reserved, 0), now()
    FROM batch b
    LEFT JOIN (
      SELECT batch_id,
             SUM(qty_delta)::int AS on_hand,
             SUM(CASE WHEN bucket = 'quarantine' THEN qty_delta ELSE 0 END)::int AS quarantined
      FROM stock_ledger
      WHERE tenant_id = ${tenantId}::uuid AND batch_id IS NOT NULL
      GROUP BY batch_id
    ) led ON led.batch_id = b.id
    LEFT JOIN (
      SELECT batch_id, SUM(qty)::int AS reserved
      FROM stock_reservation
      WHERE tenant_id = ${tenantId}::uuid AND status = 'active'
      GROUP BY batch_id
    ) res ON res.batch_id = b.id
    WHERE b.tenant_id = ${tenantId}::uuid
    ON CONFLICT (batch_id) DO UPDATE
      SET on_hand_qty = EXCLUDED.on_hand_qty,
          quarantined_qty = EXCLUDED.quarantined_qty,
          reserved_qty = EXCLUDED.reserved_qty,
          updated_at = now()
  `;
}

/**
 * Bring ledger data written the pre-reservation way into the current model: open transfer
 * reservations become `stock_reservation` rows (with a compensating ledger release), and
 * whole-batch quarantine flags become quarantined quantities. Mirrors the backfill in
 * migration 20260915090000_stock_foundation; idempotent, so safe to run after every seed.
 */
export async function convertLegacyStockState(client: SqlClient, tenantId: string): Promise<void> {
  await client.$executeRaw`
    INSERT INTO stock_reservation (id, tenant_id, branch_id, product_id, batch_id, qty, source_type, source_id, source_line_id, status, created_by, created_at)
    SELECT gen_random_uuid(), t.tenant_id, t.from_branch_id, ti.product_id, ti.batch_id, ti.qty,
           'transfer', t.id, ti.id, 'active', t.approved_by, t.updated_at
    FROM transfer t
    JOIN transfer_item ti ON ti.transfer_id = t.id AND ti.tenant_id = t.tenant_id
    WHERE t.tenant_id = ${tenantId}::uuid
      AND t.status = 'approved'
      AND ti.batch_id IS NOT NULL
      AND ti.qty > 0
      AND NOT EXISTS (
        SELECT 1 FROM stock_reservation r
        WHERE r.tenant_id = t.tenant_id AND r.source_type = 'transfer' AND r.source_line_id = ti.id
      )
  `;
  await client.$executeRaw`
    INSERT INTO stock_ledger (id, tenant_id, branch_id, product_id, batch_id, movement_type, qty_delta, bucket, reference_type, reference_id, reason, occurred_at, created_by, created_at)
    SELECT gen_random_uuid(), l.tenant_id, l.branch_id, l.product_id, l.batch_id,
           'transfer_reserve_release', -SUM(l.qty_delta), 'sellable', 'transfer', l.reference_id,
           'Reservation moved from the stock ledger to stock reservations', now(), NULL, now()
    FROM stock_ledger l
    WHERE l.tenant_id = ${tenantId}::uuid
      AND l.reference_type = 'transfer'
      AND l.movement_type IN ('transfer_reserve_out', 'transfer_reserve_release')
    GROUP BY l.tenant_id, l.branch_id, l.product_id, l.batch_id, l.reference_id
    HAVING SUM(l.qty_delta) <> 0
  `;
  await client.$executeRaw`
    WITH held AS MATERIALIZED (
      SELECT b.id AS batch_id, b.tenant_id, b.branch_id, b.product_id,
             (SUM(l.qty_delta) - SUM(CASE WHEN l.bucket = 'quarantine' THEN l.qty_delta ELSE 0 END))::int AS sellable,
             b.quarantine_reason, b.quarantined_at, gen_random_uuid() AS ref
      FROM batch b
      JOIN stock_ledger l ON l.batch_id = b.id AND l.tenant_id = b.tenant_id
      WHERE b.tenant_id = ${tenantId}::uuid AND b.is_quarantined = true
      GROUP BY b.id
      HAVING SUM(l.qty_delta) - SUM(CASE WHEN l.bucket = 'quarantine' THEN l.qty_delta ELSE 0 END) > 0
    )
    INSERT INTO stock_ledger (id, tenant_id, branch_id, product_id, batch_id, movement_type, qty_delta, bucket, reference_type, reference_id, reason, reason_code, occurred_at, created_by, created_at)
    SELECT gen_random_uuid(), h.tenant_id, h.branch_id, h.product_id, h.batch_id,
           'quarantine_hold', side.delta, side.bucket::"StockBucket", 'batch_quarantine', h.ref,
           COALESCE(h.quarantine_reason, 'Quarantined'),
           CASE WHEN h.quarantine_reason = 'Auto-quarantined: expired' THEN 'expired' ELSE 'other' END,
           COALESCE(h.quarantined_at, now()), NULL, now()
    FROM held h
    CROSS JOIN LATERAL (VALUES (-h.sellable, 'sellable'), (h.sellable, 'quarantine')) AS side(delta, bucket)
  `;
}

/** Batches whose running totals disagree with the ledger or reservations. Empty is healthy. */
export async function findStockProjectionMismatches(
  client: SqlClient,
  tenantId?: string,
): Promise<StockProjectionMismatch[]> {
  const tenantFilter = tenantId
    ? Prisma.sql`AND b.tenant_id = ${tenantId}::uuid`
    : Prisma.empty;
  const rows = await client.$queryRaw<
    Array<{
      batch_id: string;
      on_hand_qty: number | null;
      ledger_on_hand: number;
      quarantined_qty: number | null;
      ledger_quarantined: number;
      reserved_qty: number | null;
      active_reserved: number;
    }>
  >`
    SELECT b.id AS batch_id,
           bs.on_hand_qty, COALESCE(led.on_hand, 0)::int AS ledger_on_hand,
           bs.quarantined_qty, COALESCE(led.quarantined, 0)::int AS ledger_quarantined,
           bs.reserved_qty, COALESCE(res.reserved, 0)::int AS active_reserved
    FROM batch b
    LEFT JOIN batch_stock bs ON bs.batch_id = b.id
    LEFT JOIN (
      SELECT batch_id, SUM(qty_delta) AS on_hand,
             SUM(CASE WHEN bucket = 'quarantine' THEN qty_delta ELSE 0 END) AS quarantined
      FROM stock_ledger WHERE batch_id IS NOT NULL GROUP BY batch_id
    ) led ON led.batch_id = b.id
    LEFT JOIN (
      SELECT batch_id, SUM(qty) AS reserved
      FROM stock_reservation WHERE status = 'active' GROUP BY batch_id
    ) res ON res.batch_id = b.id
    WHERE (
      COALESCE(bs.on_hand_qty, 0) <> COALESCE(led.on_hand, 0)
      OR COALESCE(bs.quarantined_qty, 0) <> COALESCE(led.quarantined, 0)
      OR COALESCE(bs.reserved_qty, 0) <> COALESCE(res.reserved, 0)
    )
    ${tenantFilter}
  `;
  return rows.map((row) => ({
    batchId: row.batch_id,
    onHandQty: row.on_hand_qty ?? 0,
    ledgerOnHand: Number(row.ledger_on_hand),
    quarantinedQty: row.quarantined_qty ?? 0,
    ledgerQuarantined: Number(row.ledger_quarantined),
    reservedQty: row.reserved_qty ?? 0,
    activeReserved: Number(row.active_reserved),
  }));
}
