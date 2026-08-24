import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import pg from "pg";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const roleName = `pc_canary_${suffix}`;
const rolePassword = `Pc_${suffix}_password`;
const tenantA = randomUUID();
const tenantB = randomUUID();
const branchA1 = randomUUID();
const branchA2 = randomUUID();
const branchB1 = randomUUID();
const userA = randomUUID();
const userB = randomUUID();
const productA = randomUUID();
const productB = randomUUID();
const batchA1 = randomUUID();
const batchA2 = randomUUID();
const batchB1 = randomUUID();
const saleA1 = randomUUID();
const saleA2 = randomUUID();
const saleB1 = randomUUID();

const admin = new Pool({ connectionString: databaseUrl, max: 1 });
let application;

function applicationUrl() {
  const url = new URL(databaseUrl);
  url.username = roleName;
  url.password = rolePassword;
  return url.toString();
}

async function setCanaryState(enabled) {
  const verb = enabled ? "ENABLE" : "DISABLE";
  for (const table of ["product", "batch", "sale"]) {
    await admin.query(`ALTER TABLE "${table}" ${verb} ROW LEVEL SECURITY`);
    if (enabled) {
      await admin.query(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
    } else {
      await admin.query(`ALTER TABLE "${table}" NO FORCE ROW LEVEL SECURITY`);
    }
  }
}

async function seedFixtures() {
  await admin.query(
    `INSERT INTO tenant
       (id, code, legal_name, display_name, compliance_region, created_at, updated_at)
     VALUES ($1, $2, 'Canary Tenant A', 'Canary A', 'LK', now(), now()),
            ($3, $4, 'Canary Tenant B', 'Canary B', 'LK', now(), now())`,
    [tenantA, `canary-a-${suffix}`, tenantB, `canary-b-${suffix}`],
  );
  await admin.query(
    `INSERT INTO branch
       (id, tenant_id, code, name, timezone, created_at, updated_at)
     VALUES ($1, $2, 'A1', 'A One', 'Asia/Colombo', now(), now()),
            ($3, $2, 'A2', 'A Two', 'Asia/Colombo', now(), now()),
            ($4, $5, 'B1', 'B One', 'Asia/Colombo', now(), now())`,
    [branchA1, tenantA, branchA2, branchB1, tenantB],
  );
  await admin.query(
    `INSERT INTO app_user
       (id, tenant_id, email, full_name, password_hash, created_at, updated_at)
     VALUES ($1, $2, $3, 'Canary User A', 'not-a-login', now(), now()),
            ($4, $5, $6, 'Canary User B', 'not-a-login', now(), now())`,
    [
      userA,
      tenantA,
      `canary-a-${suffix}@example.invalid`,
      userB,
      tenantB,
      `canary-b-${suffix}@example.invalid`,
    ],
  );
  await admin.query(
    `INSERT INTO product
       (id, tenant_id, sku, name, created_at, updated_at)
     VALUES ($1, $2, 'CANARY-A', 'Tenant A Product', now(), now()),
            ($3, $4, 'CANARY-B', 'Tenant B Product', now(), now())`,
    [productA, tenantA, productB, tenantB],
  );
  await admin.query(
    `INSERT INTO batch
       (id, tenant_id, branch_id, product_id, batch_no, expiry_date,
        cost_price, selling_price, received_at, created_at)
     VALUES ($1, $2, $3, $4, 'A1-BATCH', current_date + 365, 10, 12, now(), now()),
            ($5, $2, $6, $4, 'A2-BATCH', current_date + 365, 10, 12, now(), now()),
            ($7, $8, $9, $10, 'B1-BATCH', current_date + 365, 10, 12, now(), now())`,
    [
      batchA1,
      tenantA,
      branchA1,
      productA,
      batchA2,
      branchA2,
      batchB1,
      tenantB,
      branchB1,
      productB,
    ],
  );
  await admin.query(
    `INSERT INTO sale
       (id, tenant_id, branch_id, invoice_no, subtotal, grand_total, sold_by, created_at)
     VALUES ($1, $2, $3, 'A1-INVOICE', 12, 12, $4, now()),
            ($5, $2, $6, 'A2-INVOICE', 12, 12, $4, now()),
            ($7, $8, $9, 'B1-INVOICE', 12, 12, $10, now())`,
    [
      saleA1,
      tenantA,
      branchA1,
      userA,
      saleA2,
      branchA2,
      saleB1,
      tenantB,
      branchB1,
      userB,
    ],
  );
}

async function inScope(tenantId, branchId, work) {
  return application.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      "SELECT set_config('app.tenant_id', $1, true)",
      tenantId,
    );
    await tx.$executeRawUnsafe(
      "SELECT set_config('app.branch_id', $1, true)",
      branchId ?? "",
    );
    return work(tx);
  });
}

async function cleanup() {
  if (application) await application.$disconnect().catch(() => undefined);
  await setCanaryState(false).catch(() => undefined);
  for (const table of [
    "sale",
    "batch",
    "product",
    "app_user",
    "branch",
    "tenant",
  ]) {
    const column = table === "tenant" ? "id" : "tenant_id";
    await admin
      .query(
        `DELETE FROM "${table}" WHERE "${column}" = ANY($1::uuid[])`,
        [[tenantA, tenantB]],
      )
      .catch(() => undefined);
  }
  await admin.query(`DROP ROLE IF EXISTS "${roleName}"`).catch(() => undefined);
  await admin.end();
}

try {
  await seedFixtures();
  await admin.query(
    `CREATE ROLE "${roleName}" LOGIN PASSWORD '${rolePassword}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
  );
  await admin.query(`GRANT USAGE ON SCHEMA public TO "${roleName}"`);
  await admin.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE
       ON TABLE product, batch, sale TO "${roleName}"`,
  );
  await setCanaryState(true);

  const roleState = await admin.query(
    `SELECT r.rolsuper, r.rolbypassrls,
            bool_or(pg_get_userbyid(c.relowner) = r.rolname) AS owns_canary_table
       FROM pg_roles r
       CROSS JOIN pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE r.rolname = $1
        AND n.nspname = 'public'
        AND c.relname = ANY($2::text[])
      GROUP BY r.rolsuper, r.rolbypassrls`,
    [roleName, ["product", "batch", "sale"]],
  );
  assert.deepEqual(roleState.rows, [
    {
      rolsuper: false,
      rolbypassrls: false,
      owns_canary_table: false,
    },
  ]);

  application = new PrismaClient({
    adapter: new PrismaPg({ connectionString: applicationUrl() }),
  });
  await application.$connect();

  assert.equal(await application.product.count(), 0);
  assert.equal(await application.batch.count(), 0);
  assert.equal(await application.sale.count(), 0);

  await inScope(tenantA, branchA1, async (tx) => {
    assert.deepEqual(
      await tx.product.findMany({ select: { id: true }, orderBy: { id: "asc" } }),
      [{ id: productA }],
    );
    assert.deepEqual(await tx.batch.findMany({ select: { id: true } }), [
      { id: batchA1 },
    ]);
    assert.deepEqual(await tx.sale.findMany({ select: { id: true } }), [
      { id: saleA1 },
    ]);
  });

  await inScope(tenantA, undefined, async (tx) => {
    assert.equal(await tx.product.count(), 1);
    assert.equal(await tx.batch.count(), 2);
    assert.equal(await tx.sale.count(), 2);
  });

  await assert.rejects(
    inScope(tenantA, branchA1, (tx) =>
      tx.product.create({
        data: {
          tenantId: tenantB,
          sku: `CROSS-${suffix}`,
          name: "Cross-tenant write",
        },
      }),
    ),
  );

  await inScope(tenantB, branchB1, async (tx) => {
    assert.equal(
      (
        await tx.product.updateMany({
          where: { id: productA },
          data: { name: "Must not update" },
        })
      ).count,
      0,
    );
    assert.equal(
      (await tx.product.deleteMany({ where: { id: productA } })).count,
      0,
    );
  });

  await inScope(tenantA, branchA1, async (tx) => {
    const created = await tx.product.create({
      data: {
        tenantId: tenantA,
        sku: `WRITE-${suffix}`,
        name: "Allowed canary write",
      },
      select: { id: true },
    });
    assert.equal(
      (await tx.product.deleteMany({ where: { id: created.id } })).count,
      1,
    );
  });

  const samples = 20;
  const startedAt = performance.now();
  for (let index = 0; index < samples; index += 1) {
    await inScope(tenantA, index % 2 === 0 ? branchA1 : branchA2, (tx) =>
      tx.batch.count(),
    );
  }
  const averageMs = (performance.now() - startedAt) / samples;
  assert.ok(
    averageMs < 250,
    `RLS transaction smoke threshold exceeded: ${averageMs.toFixed(1)}ms average`,
  );

  console.log(
    `Real canary activation passed for Product, Batch, and Sale; ${averageMs.toFixed(1)}ms average scoped transaction.`,
  );
} finally {
  await cleanup();
}
