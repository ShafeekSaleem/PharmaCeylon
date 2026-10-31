import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type { TerminalIdentity } from "@pharmaceylon/shared";
import { denied } from "./terminal-wire";

export type AttendanceExpectation = Readonly<{
  purpose: "enrollment" | "session" | "command";
  identity: TerminalIdentity;
  actorUserId: string;
  registerId: string;
  tillId: string;
  payloadDigest: string;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Consumes one proof recorded by `AttendanceProofsService`: a signed desktop-main attestation
 * of the physical console Windows session, bound to this exact purpose, identity, actor, counter
 * and challenge digest. Consumption shares the caller's transaction, so a failed operation
 * rolls it back. A renderer boolean, HTTP header or device signature alone cannot satisfy this;
 * there is no runtime fixture/configuration bypass.
 */
@Injectable()
export class LocalAttendanceVerifier {
  async verify(
    tx: Prisma.TransactionClient,
    proofId: string,
    expected: AttendanceExpectation,
  ): Promise<string> {
    if (!UUID.test(proofId)) denied("LOCAL_ATTENDANCE_UNAVAILABLE");
    const { identity } = expected;
    // Two operations presenting the same proof serialize here; the second sees it consumed.
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM terminal_attendance_proof
      WHERE tenant_id = ${identity.tenantId}::uuid AND branch_id = ${identity.branchId}::uuid
        AND id = ${proofId}::uuid FOR UPDATE`;
    if (rows.length !== 1) denied("LOCAL_ATTENDANCE_UNAVAILABLE");
    const proof = await tx.terminalAttendanceProof.findFirst({
      where: { tenantId: identity.tenantId, branchId: identity.branchId, id: proofId },
    });
    if (
      !proof ||
      proof.consumedAt ||
      proof.expiresAt.getTime() <= Date.now() ||
      proof.sessionProtocol !== "console" ||
      proof.purpose !== expected.purpose ||
      proof.terminalId !== identity.terminalId ||
      proof.enrollmentId !== identity.enrollmentId ||
      proof.keyId !== identity.keyId ||
      proof.actorUserId !== expected.actorUserId ||
      proof.registerId !== expected.registerId ||
      proof.tillId !== expected.tillId ||
      proof.payloadDigest !== expected.payloadDigest
    )
      denied("LOCAL_ATTENDANCE_UNAVAILABLE");
    const consumed = await tx.terminalAttendanceProof.updateMany({
      where: { tenantId: identity.tenantId, branchId: identity.branchId, id: proofId, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1) denied("LOCAL_ATTENDANCE_UNAVAILABLE");
    return proof.id;
  }
}
