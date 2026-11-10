import { Body, Controller, HttpCode, Post, UseFilters } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createPrivateKey } from "node:crypto";
import { TaxService } from "../pricing/tax.service";
import { PrismaService } from "../prisma/prisma.service";
import { AccessService } from "../security/access.service";
import { CounterRoute } from "../security/decorators/counter-route.decorator";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { RequireBranchId } from "../security/decorators/require-branch.decorator";
import { RequirePermission } from "../security/decorators/require-permission.decorator";
import type { RequestUser } from "../security/interfaces/authenticated-request.interface";
import {
  acceptedJournalHead,
  acceptedJournalState,
  isNominated,
  issueOfflineAuthority,
  journalAwaitingReview,
} from "./offline-authority-issuance";
import { TerminalErrorFilter } from "./terminal-error.filter";
import { TerminalTrustService } from "./terminal-trust.service";
import { denied, object, text, uuid } from "./terminal-wire";

const permission = "terminal.execute";
const descriptor = {
  operation: "POST /api/v1/terminals/offline-authority",
  permission,
  parseBody(raw: unknown) {
    const body = object(raw, ["requestId"]);
    return { requestId: uuid(body.requestId) };
  },
};

@UseFilters(TerminalErrorFilter)
@Controller("terminals/offline-authority")
export class OfflineAuthorityController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly trust: TerminalTrustService,
    private readonly access: AccessService,
    private readonly config: ConfigService,
    private readonly tax: TaxService,
  ) {}

  @CounterRoute()
  @RequirePermission(permission)
  @Post("challenge")
  @HttpCode(200)
  prepare(@CurrentUser() user: RequestUser, @RequireBranchId() branchId: string, @Body() raw: unknown) {
    const body = object(raw, ["workSessionId", "requestId"]);
    const workSessionId = uuid(body.workSessionId);
    const requestId = uuid(body.requestId);
    return this.prisma.$transaction(async (tx) => {
      const command = await this.trust.prepareCommand(tx, user, branchId, workSessionId, descriptor, { requestId });
      // Only the branch's offline counter gets authority. Refusing here, before the counter spends
      // an attendance proof, rolls the challenge back with the transaction.
      if (!(await isNominated(tx, command.identity))) denied("IDENTITY_MISMATCH");
      // Likewise a counter whose offline journal is stuck on an entry that needs review (P5 #51),
      // unless this request ID was already issued: a lost response must stay recoverable. An
      // accepted journal is not a refusal: the pair is rebased over it.
      const { tenantId, branchId: scopeBranchId, enrollmentId } = command.identity;
      const issued = await tx.offlineAuthorityIssuance.findUnique({
        where: { tenantId_branchId_enrollmentId_commandId: { tenantId, branchId: scopeBranchId, enrollmentId, commandId: requestId } },
        select: { snapshotId: true },
      });
      if (!issued) {
        const head = await acceptedJournalHead(tx, command.identity);
        if (await journalAwaitingReview(tx, command.identity, head.sequence)) denied("RECONCILIATION_REQUIRED");
      }
      return command;
    });
  }

  @CounterRoute()
  @RequirePermission(permission)
  @Post()
  @HttpCode(200)
  issue(@CurrentUser() user: RequestUser, @RequireBranchId() branchId: string, @Body() raw: unknown) {
    const body = object(raw, ["envelope", "attendanceProofId"]);
    const proofId = text(body.attendanceProofId);
    const keyId = this.config.get<string>("OFFLINE_AUTHORITY_KEY_ID");
    const keyPem = this.config.get<string>("OFFLINE_AUTHORITY_PRIVATE_KEY");
    if (!keyId || !keyPem) denied("TEMPORARILY_UNAVAILABLE");
    return issueOfflineAuthority(this.prisma, this.access, {
      // A PEM in a .env file is often one line with literal "\n" escapes.
      signer: { keyId, privateKey: createPrivateKey(keyPem.replace(/\\n/g, "\n")) },
      defaultVatRatePercent: this.tax.getVatRatePercent(),
      authenticate: async (tx) => {
        const { command } = await this.trust.verifyCommand(tx, user, branchId, descriptor, body.envelope, proofId);
        return { identity: command.identity, commandId: command.body.requestId };
      },
      readState: acceptedJournalState,
    });
  }
}
