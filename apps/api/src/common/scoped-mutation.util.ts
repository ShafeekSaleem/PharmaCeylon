import { NotFoundException } from "@nestjs/common";

export type ScopedMutationResult = { count: number };

/**
 * Enforces the final write boundary for tenant/branch-owned records.
 *
 * Use with updateMany/deleteMany whose where clause contains the resource id
 * plus tenantId (and branchId for branch-owned records). A preceding scoped
 * read is still useful for workflow validation, but the mutation itself must
 * never rely on that read as its only isolation control.
 */
export function assertOneScopedMutation(
  result: ScopedMutationResult,
  resourceName: string,
): void {
  if (result.count !== 1) {
    throw new NotFoundException(`${resourceName} not found`);
  }
}
