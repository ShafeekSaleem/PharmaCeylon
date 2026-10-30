import { ConflictException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { IDEMPOTENCY_SCOPE } from "../../common/idempotency.constants";
import { normalizeIdempotencyKey } from "../../common/idempotency.util";
import { PrismaService } from "../../prisma/prisma.service";
import { tenantTransactionStorage } from "../../prisma/tenant-transaction.store";
import { OperationAuthorizationService } from "../../security/operation-authorization.service";
import { RequestUser } from "../../security/interfaces/authenticated-request.interface";
import { SupplierLedgerService } from "./supplier-ledger.service";
import { SupplierPaymentEvidenceService } from "./supplier-payment-evidence.service";
import {
  EVIDENCED_PAYMENT_OPERATION,
  parseEvidencedRequest,
} from "./payment-evidence-material";

/** Explicit evidenced online recording adapter. Cash/other and legacy endpoints are not
 * routed here; their coordinated physical-boundary cutover remains later P1/P2 work. */
@Injectable()
export class EvidencedPaymentRecordingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: SupplierLedgerService,
    private readonly evidence: SupplierPaymentEvidenceService,
    private readonly authorization: OperationAuthorizationService,
  ) {}

  async record(
    user: RequestUser,
    branchId: string,
    input: unknown,
    key?: string,
  ) {
    const body = parseEvidencedRequest(input);
    const idempotencyKey = normalizeIdempotencyKey(key);
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.prisma.$transaction(
          async (tx) =>
            tenantTransactionStorage.run(
              { tenantId: user.tenantId, branchId, client: tx },
              async () => {
                await this.evidence.authorize(tx, user, branchId);
                const seen = idempotencyKey
                  ? await tx.idempotencyRecord.findUnique({
                      where: {
                        tenantId_userId_scope_idempotencyKey: {
                          tenantId: user.tenantId,
                          userId: user.userId,
                          scope: IDEMPOTENCY_SCOPE.supplierEvidencedPayment,
                          idempotencyKey,
                        },
                      },
                    })
                  : null;
                const context = {
                  tenantId: user.tenantId,
                  branchId,
                  actorUserId: user.userId,
                  operation: EVIDENCED_PAYMENT_OPERATION,
                  body,
                };
                const proof = await this.evidence.forRecording(tx, context);
                if (seen && seen.resourceId !== proof.consumedPaymentId)
                  throw new ConflictException(
                    "Idempotency-Key was used for a different payment/evidence binding.",
                  );
                let paymentId = proof.consumedPaymentId;
                if (!paymentId) {
                  paymentId = await this.ledger.recordPaymentInTransaction(
                    tx,
                    user.tenantId,
                    branchId,
                    user.userId,
                    { ...body.payment, notes: body.payment.notes ?? undefined },
                    {
                      before: async (tx) => {
                        await this.authorization.authorize(
                          tx,
                          user,
                          branchId,
                          {
                            method: "POST",
                            routeTemplate:
                              "/api/v1/purchasing/payments/evidenced",
                            permission: "suppliers.pay",
                            parseBody: parseEvidencedRequest,
                            resolveFacts: async () => ({ paymentKind: "bank" }),
                          },
                          { body },
                        );
                      },
                      after: (tx, id) => this.evidence.consume(tx, context, id),
                      provenance: {
                        evidenceId: proof.id,
                        evidenceDigest: proof.materialDigest,
                        uploadedBy: proof.uploadedBy,
                      },
                    },
                  );
                }
                if (idempotencyKey && !seen)
                  await tx.idempotencyRecord.create({
                    data: {
                      tenantId: user.tenantId,
                      userId: user.userId,
                      scope: IDEMPOTENCY_SCOPE.supplierEvidencedPayment,
                      idempotencyKey,
                      resourceId: paymentId,
                    },
                  });
                const result = await this.ledger.paymentById(
                  user.tenantId,
                  paymentId,
                );
                // Ledger, sequence, audit and idempotency writes can wait after initial evidence.
                // Final current actor + immutable proof recheck happens after all those writes.
                const finalProof = await this.evidence.forRecording(
                  tx,
                  context,
                  false,
                );
                if (finalProof.consumedPaymentId !== paymentId)
                  throw new ConflictException("Payment evidence changed.");
                await this.evidence.authorize(tx, user, branchId);
                return {
                  ...result,
                  evidenceId: proof.id,
                  evidenceDigest: proof.materialDigest,
                };
              },
            ),
          { timeout: 60_000, maxWait: 30_000 },
        );
      } catch (error) {
        if (
          attempt === 0 &&
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        )
          continue;
        throw error;
      }
    }
  }
}
