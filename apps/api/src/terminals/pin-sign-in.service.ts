import { ForbiddenException, Injectable } from "@nestjs/common";
import type {
  TerminalPinSessionCommand,
  TerminalPinSignInResult,
} from "@pharmaceylon/shared";
import { AuthService, type RequestMeta } from "../auth/auth.service";
import { PrismaService } from "../prisma/prisma.service";
import { AttendanceProofsService } from "./attendance-proofs.service";
import { PIN, pinRefusal } from "./pos-pin";
import { TerminalTrustService } from "./terminal-trust.service";
import { object } from "./terminal-wire";

/**
 * D-W5 sign-in with a personal PIN at an enrolled counter (P2b #103), for the people prepared
 * there. Nobody is signed in, so the device key, a console attendance proof and the server's own
 * PIN verifier and lockout stand in for the password. What it opens is deliberately small: a
 * login that works only at this counter (`@CounterRoute()` routes, its branch) and ends with the
 * counter staff session. Contract: docs/API_CONTRACT.md, "PIN sign-in at a counter".
 */
@Injectable()
export class PinSignInService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly trust: TerminalTrustService,
    private readonly proofs: AttendanceProofsService,
    private readonly auth: AuthService,
  ) {}

  begin(raw: unknown): Promise<TerminalPinSessionCommand> {
    return this.prisma.$transaction((tx) => this.trust.beginPinSession(tx, raw));
  }

  async finish(
    raw: unknown,
    meta: RequestMeta,
  ): Promise<TerminalPinSignInResult> {
    const body = object(raw, ["envelope", "attendance", "pin"]);
    const pin = body.pin;
    if (typeof pin !== "string" || !PIN.test(pin))
      throw new ForbiddenException({
        code: "PIN_FORMAT",
        message: "A PIN is 4 to 8 digits.",
      });
    // A wrong PIN commits (the guess is counted, the challenge spent) and is refused after.
    const result = await this.prisma.$transaction((tx) =>
      this.trust.finishPinSession(tx, body.envelope, pin, (challenge, key) =>
        this.proofs.recordForPinSession(tx, body.attendance, challenge, key),
      ),
    );
    if (result.outcome !== "signed_in") pinRefusal(result.outcome);
    const { session, tenantId } = result;
    try {
      const login = await this.auth.issueCounterSession(
        session.staffUserId,
        tenantId,
        session.workSessionId,
        meta,
      );
      const { user } = login;
      return {
        accessToken: login.accessToken,
        refreshToken: login.refreshToken,
        user: {
          id: user.id,
          tenantId: user.tenantId,
          email: user.email,
          fullName: user.fullName,
          roles: user.roles,
          branchRoles: user.branchRoles,
        },
        session,
      };
    } catch (error) {
      // No login, so no one is signed in there: don't leave the till bound to this person.
      await this.prisma.terminalStaffSession.updateMany({
        where: { tenantId, id: session.workSessionId, closedAt: null },
        data: { closedAt: new Date() },
      });
      throw error;
    }
  }
}
