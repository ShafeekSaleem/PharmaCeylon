import "dotenv/config";
import pg from "pg";

/**
 * Read-only check that every batch's running totals (`batch_stock`) still equal what the stock
 * ledger and active reservations say. The app keeps them in step inside each stock transaction;
 * this is the independent proof, for staging, production and after any manual data repair.
 *
 *   node scripts/reconcile-stock.mjs            # every tenant
 *   node scripts/reconcile-stock.mjs <tenantId> # one tenant
 *
 * Exits 1 and lists the batches when anything disagrees.
 */

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const tenantId = process.argv[2] ?? null;

const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
try {
  const { rows } = await pool.query(
    `SELECT b.tenant_id, b.branch_id, b.id AS batch_id, b.batch_no,
            COALESCE(bs.on_hand_qty, 0) AS on_hand_qty, COALESCE(led.on_hand, 0)::int AS ledger_on_hand,
            COALESCE(bs.quarantined_qty, 0) AS quarantined_qty, COALESCE(led.quarantined, 0)::int AS ledger_quarantined,
            COALESCE(bs.reserved_qty, 0) AS reserved_qty, COALESCE(res.reserved, 0)::int AS active_reserved
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
      WHERE ($1::uuid IS NULL OR b.tenant_id = $1::uuid)
        AND (COALESCE(bs.on_hand_qty, 0) <> COALESCE(led.on_hand, 0)
          OR COALESCE(bs.quarantined_qty, 0) <> COALESCE(led.quarantined, 0)
          OR COALESCE(bs.reserved_qty, 0) <> COALESCE(res.reserved, 0))
      ORDER BY b.tenant_id, b.branch_id, b.batch_no`,
    [tenantId],
  );

  const negative = await pool.query(
    `SELECT count(*)::int AS n FROM batch_stock
      WHERE ($1::uuid IS NULL OR tenant_id = $1::uuid)
        AND (on_hand_qty < 0 OR quarantined_qty < 0 OR reserved_qty < 0)`,
    [tenantId],
  );

  if (rows.length > 0 || negative.rows[0].n > 0) {
    console.error(`Stock reconciliation failed: ${rows.length} mismatched batch(es), ${negative.rows[0].n} negative total(s).`);
    for (const row of rows.slice(0, 50)) {
      console.error(
        `  ${row.batch_no} (${row.batch_id}): on hand ${row.on_hand_qty} vs ledger ${row.ledger_on_hand}; ` +
          `quarantined ${row.quarantined_qty} vs ${row.ledger_quarantined}; reserved ${row.reserved_qty} vs ${row.active_reserved}`,
      );
    }
    process.exit(1);
  }
  console.log("Stock reconciliation passed: batch totals match the ledger and reservations.");
} finally {
  await pool.end();
}
