import { ForbiddenException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AccessService, type ActorAccess } from "../security/access.service";
import type { ApproverCoSignDto } from "./dto/approver-cosign.dto";
import { PharmacistApprovalService } from "./pharmacist-approval.service";

type Db = Prisma.TransactionClient | PrismaService;

/** What a co-signer is approving, with the permission it takes. */
export const CO_SIGN_PERMISSION = {
  discount: "sales.discount_override",
  refund: "returns.approve",
} as const;
export type CoSignPurpose = keyof typeof CO_SIGN_PERMISSION;

export type VerifiedCoSigner = { approverUserId: string; approverName: string };

/**
 * The approver co-sign (P2b #103), shared by discounts over the limit and refunds over the
 * threshold: someone with the authority approves on another person's session, on the same
 * counter, by choosing their name and entering their own till PIN. It works the way the
 * pharmacist co-sign does (`PharmacistApprovalService.verifyApproverPin`): the same PIN lockout,
 * the same 403-never-401 refusals.
 *
 * Two checks, both on the server and both live:
 * 1. `verify` checks the PIN, outside any transaction, so a wrong one still counts towards the
 *    lockout when the request then fails.
 * 2. `assertAuthority` re-reads the approver's membership, branch roles and grants from the
 *    database (`AccessService.resolveApprovalAuthority`), not from a token or the in-process
 *    permission cache, so a manager demoted a second ago can't co-sign.
 *
 * The co-sign is online only: no signed or offline counter command carries one. The PIN is
 * compared and dropped; it is never logged, audited or stored with the request.
 */
@Injectable()
export class ApproverCoSignService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly pins: PharmacistApprovalService,
  ) {}

  async verify(input: {
    tenantId: string;
    branchId: string;
    /** Whose session the co-sign is entered on: the seller, or the person refunding. */
    sessionUserId: string;
    coSign: ApproverCoSignDto;
    purpose: CoSignPurpose;
  }): Promise<VerifiedCoSigner> {
    // A co-sign is a second person. Someone approving their own work does it under their own
    // authority (and the self-approval setting), never by typing their PIN into their own sale.
    if (input.coSign.approverUserId === input.sessionUserId) {
      throw new ForbiddenException({
        code: "APPROVER_IS_SELF",
        message:
          input.purpose === "discount"
            ? "You can't co-sign your own sale. Ask another manager to enter their till PIN."
            : "You can't co-sign your own refund. Ask another approver to enter their till PIN.",
      });
    }
    return this.pins.verifyApproverPin(
      input.tenantId,
      input.branchId,
      input.coSign.approverUserId,
      input.coSign.pin,
      input.sessionUserId,
      CO_SIGN_PERMISSION[input.purpose],
    );
  }

  /** The approver's current authority at the branch, read on `db`. */
  async assertAuthority(
    db: Db,
    tenantId: string,
    branchId: string,
    approverUserId: string,
    purpose: CoSignPurpose,
  ): Promise<void> {
    const access = await this.liveAccess(db, tenantId, branchId, approverUserId);
    if (!access?.has(CO_SIGN_PERMISSION[purpose])) {
      throw new ForbiddenException({
        code: "APPROVER_NOT_AUTHORISED",
        message:
          purpose === "discount"
            ? "The selected person can't approve discounts over the limit at this branch."
            : "The selected person can't approve refunds at this branch.",
      });
    }
  }

  /**
   * The seller's own live authority to approve their own discount without a co-sign: the
   * permission, and a role the tenant lets approve its own requests (`selfApprovalRoleKeys`).
   */
  async sellerMayApprove(tenantId: string, branchId: string, userId: string, purpose: CoSignPurpose) {
    const access = await this.liveAccess(this.prisma, tenantId, branchId, userId);
    return Boolean(access?.has(CO_SIGN_PERMISSION[purpose]) && access.canSelfApprove);
  }

  /** Null when the person is no longer an active member assigned to the branch. */
  private async liveAccess(db: Db, tenantId: string, branchId: string, userId: string): Promise<ActorAccess | null> {
    try {
      return await this.access.resolveApprovalAuthority({ tenantId, userId }, branchId, db as Prisma.TransactionClient);
    } catch (error) {
      if (error instanceof ForbiddenException) return null;
      throw error;
    }
  }
}
