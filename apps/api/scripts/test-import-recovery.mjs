// Run only against a disposable, migrated CI database. Never seeds or clears existing tenants.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ConfigService } from "@nestjs/config";
import pg from "pg";
import { PrismaService } from "../dist/src/prisma/prisma.service.js";
import { AuditService } from "../dist/src/audit/audit.service.js";
import { ProductImportService } from "../dist/src/product-import/product-import.service.js";
import { ImportJobRunner } from "../dist/src/product-import/import-job-runner.js";

if (
  process.env.PHASE67_DB_TEST_ACK !== "ephemeral-database" ||
  !process.env.DATABASE_URL
) {
  throw new Error(
    "Set PHASE67_DB_TEST_ACK=ephemeral-database and DATABASE_URL to a disposable migrated database",
  );
}
const prisma = new PrismaService(
  new ConfigService({ DATABASE_URL: process.env.DATABASE_URL }),
);
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
});
const audit = new AuditService(prisma);
const runner = new ImportJobRunner(prisma);
const taxonomy = {
  assignMissingPrimaryCommercial: async () => 0,
  applyDeterministicMedicineClassification: async () => ({ reclassified: 0 }),
};
const tasks = { refresh: async () => ({ created: 0, updated: 0, closed: 0 }) };
const service = new ProductImportService(
  prisma,
  audit,
  taxonomy,
  runner,
  tasks,
);
const tenantId = randomUUID(),
  branchId = randomUUID(),
  userId = randomUUID();
const mapping = {
  name: "Name",
  barcode: "Barcode",
  qty: "Qty",
  batchNo: "Batch",
  sellingPrice: "Price",
};
const file = (prefix, count) => ({
  originalname: "recovery.csv",
  mimetype: "text/csv",
  buffer: Buffer.from(
    "Name,Barcode,Qty,Batch,Price\n" +
      Array.from(
        { length: count },
        (_, i) => `${prefix} ${i},${prefix}-${i},1,B${i},10`,
      ).join("\n"),
  ),
});
async function waitFor(importId) {
  for (let i = 0; i < 200; i++) {
    const row = await prisma.productImport.findFirst({
      where: { id: importId, tenantId },
    });
    if (row?.status !== "running") return row;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${importId}`);
}
try {
  await prisma.tenant.create({
    data: {
      id: tenantId,
      code: `recovery-${tenantId}`,
      legalName: "Recovery test",
      displayName: "Recovery test",
      complianceRegion: "LK",
    },
  });
  await prisma.branch.create({
    data: {
      id: branchId,
      tenantId,
      code: "MAIN",
      name: "Main",
      timezone: "Asia/Colombo",
    },
  });
  await prisma.appUser.create({
    data: {
      id: userId,
      tenantId,
      email: `${userId}@example.invalid`,
      fullName: "Test",
      passwordHash: "unused-test-identity",
    },
  });

  // Stop after a committed stock chunk: counters and guarded undo must reflect real writes.
  const post = service.postOpeningStock.bind(service);
  service.postOpeningStock = async (...args) => {
    args[4] = args[4].slice(0, 100);
    await post(...args);
    throw new Error("Injected interruption after first committed stock chunk");
  };
  const partial = await service.startImport(
    tenantId,
    userId,
    branchId,
    file("partial", 101),
    mapping,
    [],
    {},
    randomUUID(),
  );
  const stopped = await waitFor(partial.importId);
  assert.equal(stopped.status, "failed");
  assert.equal(stopped.productsCreated, 101);
  assert.equal(stopped.batchesCreated, 100);
  assert.equal(stopped.unitsPosted, 100);
  await service.undo(tenantId, userId, partial.importId);
  assert.equal(await prisma.batch.count({ where: { tenantId } }), 0);
  assert.equal(await prisma.product.count({ where: { tenantId } }), 0);
  await assert.rejects(
    service.inImportTransaction(tenantId, partial.importId, async () => {
      throw new Error("must not run");
    }),
    /Import stopped/,
  );
  service.postOpeningStock = post;

  // Simultaneous retries share one durable import; completion and its audit commit together.
  const key = randomUUID(),
    upload = file("complete", 2);
  const [one, two] = await Promise.all(
    [1, 2].map(() =>
      service.startImport(
        tenantId,
        userId,
        branchId,
        upload,
        mapping,
        [],
        {},
        key,
      ),
    ),
  );
  assert.equal(one.importId, two.importId);
  const completed = await waitFor(one.importId);
  assert.equal(completed.status, "completed");
  assert.equal(completed.batchesCreated, 2);
  assert.equal(completed.result.rowsFailed, 0);
  assert.equal(
    await prisma.auditEvent.count({
      where: {
        tenantId,
        entityId: one.importId,
        eventName: "products.import_completed",
      },
    }),
    1,
  );
  assert.equal(
    (await new ImportJobRunner(prisma).getProgress(tenantId, one.importId))
      .result.batchesCreated,
    2,
  );
  await assert.rejects(
    service.startImport(
      tenantId,
      userId,
      branchId,
      file("different", 1),
      mapping,
      [],
      {},
      key,
    ),
    /different import/,
  );

  // A real concurrent stock writer holds a FK lock; undo waits and then sees its movement.
  const batch = await prisma.batch.findFirst({ where: { tenantId, branchId } });
  const writer = await pool.connect();
  try {
    await writer.query("BEGIN");
    await writer.query(
      `INSERT INTO stock_ledger(id, tenant_id, branch_id, product_id, batch_id, movement_type, qty_delta, created_by)
      VALUES ($1,$2,$3,$4,$5,'adjustment_in',1,$6)`,
      [randomUUID(), tenantId, branchId, batch.productId, batch.id, userId],
    );
    let settled = false;
    const undo = service.undo(tenantId, userId, one.importId).then(
      () => {
        settled = true;
        return null;
      },
      (error) => {
        settled = true;
        return error;
      },
    );
    await delay(150);
    assert.equal(settled, false, "undo must wait for the concurrent FK writer");
    await writer.query("COMMIT");
    const failure = await undo;
    assert.match(failure?.message ?? "", /sold or moved/);
    assert.equal(await prisma.batch.count({ where: { tenantId } }), 2);
  } finally {
    await writer.query("ROLLBACK");
    writer.release();
  }
  console.log(
    "PostgreSQL import recovery, idempotency, durable results and concurrent undo checks passed.",
  );
} finally {
  runner.onModuleDestroy();
  // Delete only fixtures belonging to this unique test tenant, in FK order.
  for (const model of [
    "stockLedger",
    "batch",
    "catalogTask",
    "productCategoryMap",
    "product",
    "productCategory",
    "auditEvent",
    "idempotencyRecord",
    "productImport",
    "appUser",
    "branch",
  ]) {
    await prisma[model].deleteMany({ where: { tenantId } });
  }
  await prisma.tenant.deleteMany({ where: { id: tenantId } });
  await prisma.$disconnect();
  await pool.end();
}
