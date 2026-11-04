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
import { issueOfflineAuthority } from "./offline-authority-issuance";
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
    return this.prisma.$transaction((tx) =>
      this.trust.prepareCommand(tx, user, branchId, workSessionId, descriptor, { requestId }),
    );
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
      signer: { keyId, privateKey: createPrivateKey(keyPem) },
      defaultVatRatePercent: this.tax.getVatRatePercent(),
      authenticate: async (tx) => {
        const { command } = await this.trust.verifyCommand(tx, user, branchId, descriptor, body.envelope, proofId);
        return { identity: command.identity, commandId: command.body.requestId };
      },
      readState: async (tx, identity) => {
        const previous = await tx.offlineAuthorityIssuance.findFirst({
          where: { tenantId: identity.tenantId, branchId: identity.branchId, enrollmentId: identity.enrollmentId },
          select: { commandId: true },
        });
        // Until reconciliation is connected, only a first issuance has a proven empty baseline.
        if (previous) denied("RECONCILIATION_REQUIRED");
        return { includedThroughSequence: 0, includedThroughHash: null, reviewRequiredBatchIds: new Set() };
      },
    });
  }
}
