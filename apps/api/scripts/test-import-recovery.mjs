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
import { StockService } from "../dist/src/inventory/stock/stock.service.js";
import { ImportStockService } from "../dist/src/product-import/import-stock.service.js";
import { AccessService } from "../dist/src/security/access.service.js";
import { PermissionsService } from "../dist/src/security/permissions.service.js";

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
// Stands in for CategoryTaxonomyService. It has to answer every call the import path makes:
// a missing one throws inside the job and fails the import for the wrong reason, which reads
// here as a recovery assertion failing rather than as a broken stub.
const taxonomy = {
  ensureCommercialTemplate: async () => {},
  assignMissingPrimaryCommercial: async () => 0,
  applyDeterministicMedicineClassification: async () => ({ reclassified: 0 }),
};
const tasks = { refresh: async () => ({ created: 0, updated: 0, closed: 0 }) };
const stock = new StockService();
const service = new ProductImportService(
  prisma,
  audit,
  taxonomy,
  runner,
  tasks,
  stock,
);
// The same live-authority check the undo-stock route passes: membership, token version, branch
// assignment and the products.import grant, all read on undo's own transaction.
const access = new AccessService(
  prisma,
  new PermissionsService(prisma, new ConfigService({})),
);
const importStock = new ImportStockService(prisma, stock, audit, access);
const tenantId = randomUUID(),
  branchId = randomUUID(),
  userId = randomUUID();
const actor = (tokenVersion = 0) => ({
  tenantId,
  userId,
  tokenVersion,
  branchRoles: [{ branchId, role: "inventory_clerk", roleId: null }],
  email: `${userId}@example.invalid`,
  fullName: "Test",
  authMethod: "bearer",
});
// Physical undo at the import's branch, exactly as POST /products/import/:id/undo-stock calls it.
const undoAtCounter = (importId, user = actor()) =>
  service.undo(tenantId, userId, importId, true, branchId, (tx) =>
    importStock.authorize(user, branchId, tx),
  );
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
  await prisma.tenantMembership.create({ data: { tenantId, userId } });
  // A built-in role without a roleRef resolves to the catalog defaults, which grant
  // inventory_clerk products.import: real authority, not the owner bypass.
  await prisma.userBranchRole.create({
    data: { tenantId, userId, branchId, role: "inventory_clerk" },
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
  // The authority callback is live: a stale token is refused and the transaction leaves the
  // partial chunk untouched, so the cleanup below is genuinely done by the authorized undo.
  await assert.rejects(
    undoAtCounter(partial.importId, actor(1)),
    /Live branch authentication required/,
  );
  assert.equal(await prisma.batch.count({ where: { tenantId } }), 100);
  assert.equal(await prisma.product.count({ where: { tenantId } }), 101);
  await undoAtCounter(partial.importId);
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
    // reference_type/reference_id are NOT NULL, and they are also what the undo guard reads:
    // anything other than this import's own product_import rows counts as stock having moved.
    await writer.query(
      `INSERT INTO stock_ledger(id, tenant_id, branch_id, product_id, batch_id, movement_type, qty_delta, reference_type, reference_id, created_by)
      VALUES ($1,$2,$3,$4,$5,'adjustment_in',1,'adjustment',$6,$7)`,
      [
        randomUUID(),
        tenantId,
        branchId,
        batch.productId,
        batch.id,
        randomUUID(),
        userId,
      ],
    );
    let settled = false;
    const undo = undoAtCounter(one.importId).then(
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
    "userBranchRole",
    "tenantMembership",
    "appUser",
    "branch",
  ]) {
    await prisma[model].deleteMany({ where: { tenantId } });
  }
  await prisma.tenant.deleteMany({ where: { id: tenantId } });
  await prisma.$disconnect();
  await pool.end();
}
