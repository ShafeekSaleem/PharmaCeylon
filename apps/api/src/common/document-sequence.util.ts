import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";

/** Atomically allocate the next document number for a tenant+branch+docType. */
export async function nextDocumentNumber(
  tx: Prisma.TransactionClient,
  tenantId: string,
  branchId: string,
  docType: string,
  prefix: string,
  pad = 5,
): Promise<string> {
  const existing = await tx.documentSequence.findUnique({
    where: {
      tenantId_branchId_docType: { tenantId, branchId, docType },
    },
  });

  let value: number;
  if (!existing) {
    await tx.documentSequence.create({
      data: {
        id: randomUUID(),
        tenantId,
        branchId,
        docType,
        nextValue: 2,
      },
    });
    value = 1;
  } else {
    const updated = await tx.documentSequence.update({
      where: { id: existing.id, tenantId, branchId },
      data: { nextValue: { increment: 1 } },
    });
    value = updated.nextValue - 1;
  }

  return `${prefix}${String(value).padStart(pad, "0")}`;
}

/**
 * Tenant-scoped sequence stored against an arbitrary branch row
 * (docType is prefixed so it never collides with branch-local counters).
 */
export async function nextTenantDocumentNumber(
  tx: Prisma.TransactionClient,
  tenantId: string,
  docType: string,
  prefix: string,
  pad = 5,
): Promise<string> {
  const anyBranch = await tx.branch.findFirst({
    where: { tenantId },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  if (!anyBranch) {
    throw new Error("No branch available for document sequence");
  }
  return nextDocumentNumber(tx, tenantId, anyBranch.id, `tenant:${docType}`, prefix, pad);
}
