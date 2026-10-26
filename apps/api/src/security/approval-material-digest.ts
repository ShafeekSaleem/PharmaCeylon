import type { Prisma } from "@prisma/client";
import { terminalSigningText } from "@pharmaceylon/shared";
import { createHash } from "node:crypto";

/** Internal, server-constructed persisted documents can exceed command wire limits.
 * Keep the existing canonical encoding/domain prefix so previously issued digests
 * remain valid. Incoming signed commands still pass through boundedCanonical.
 */
export function approvalMaterialDigest(documentType: string, material: Prisma.InputJsonObject): string {
  return createHash("sha256").update(terminalSigningText("command", {
    kind: "approval_material", documentType, material,
  }), "utf8").digest("hex");
}
