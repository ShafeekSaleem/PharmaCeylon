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

/** P2 integration port. A provider must independently authenticate the supported desktop
 * installation and current local session, bind the exact challenge/key/counter/actor, and
 * reject remote/unknown sessions. A renderer boolean, HTTP header or device signature alone
 * cannot implement this port. No runtime fixture/configuration bypass is provided.
 */
@Injectable()
export class LocalAttendanceVerifier {
  async verify(
    _tx: Prisma.TransactionClient,
    _proofId: string,
    _expected: AttendanceExpectation,
  ): Promise<string> {
    return denied("LOCAL_ATTENDANCE_UNAVAILABLE");
  }
}
