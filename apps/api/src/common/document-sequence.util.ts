import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";

/**
 * Atomically allocate the next document number for a tenant+branch+docType.
 *
 * One statement, because two of them are a race: reading "does a counter exist" and then
 * creating it let a branch's very first two documents — its first two deliveries, say — both
 * find nothing and both insert, so one transaction died on a unique violation with an error
 * nobody could act on. `ON CONFLICT DO UPDATE` creates or increments in a single write, and the
 * row lock it takes makes the second caller wait rather than collide.
 */
export async function nextDocumentNumber(
  tx: Prisma.TransactionClient,
  tenantId: string,
  branchId: string,
  docType: string,
  prefix: string,
  pad = 5,
): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ next_value: number }>>`
    INSERT INTO document_sequence (id, tenant_id, branch_id, doc_type, next_value, updated_at)
    VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${branchId}::uuid, ${docType}, 2, now())
    ON CONFLICT (tenant_id, branch_id, doc_type)
    DO UPDATE SET next_value = document_sequence.next_value + 1, updated_at = now()
    RETURNING next_value
  `;
  const nextValue = rows[0]?.next_value;
  if (!nextValue) {
    throw new Error(`Could not allocate a ${docType} number`);
  }
  // The row now holds the *following* number, so the one just claimed is one below it.
  return `${prefix}${String(nextValue - 1).padStart(pad, "0")}`;
}

/**
 * Tenant-scoped sequence stored against one branch row
 * (docType is prefixed so it never collides with branch-local counters).
 *
 * The counter stays on the branch that already holds it. Choosing "the tenant's first branch"
 * afresh on every call was not stable: branches created together tie on `created_at`, and which
 * tied row Postgres returns first depends on the plan (an index scan on `(tenant_id, id)` and a
 * sequential scan disagree), so the counter could move to the other branch and start again at 1.
 * That number is already taken, and the unique index refuses it on every retry. A tenant whose
 * counter already split that way keeps the higher one, which is past every number either issued.
 */
export async function nextTenantDocumentNumber(
  tx: Prisma.TransactionClient,
  tenantId: string,
  docType: string,
  prefix: string,
  pad = 5,
): Promise<string> {
  const key = `tenant:${docType}`;
  const held = await tx.documentSequence.findFirst({
    where: { tenantId, docType: key },
    select: { branchId: true },
    orderBy: [{ nextValue: "desc" }, { branchId: "asc" }],
  });
  const branchId =
    held?.branchId ??
    (
      await tx.branch.findFirst({
        where: { tenantId },
        select: { id: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      })
    )?.id;
  if (!branchId) {
    throw new Error("No branch available for document sequence");
  }
  return nextDocumentNumber(tx, tenantId, branchId, key, prefix, pad);
}
