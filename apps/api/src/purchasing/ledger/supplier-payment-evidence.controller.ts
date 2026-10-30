/// <reference types="multer" />
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { CurrentUser } from "../../security/decorators/current-user.decorator";
import { RequireBranchId } from "../../security/decorators/require-branch.decorator";
import { RequirePermission } from "../../security/decorators/require-permission.decorator";
import { RequestUser } from "../../security/interfaces/authenticated-request.interface";
import {
  PAYMENT_EVIDENCE_FILE_LIMIT,
  SupplierPaymentEvidenceService,
} from "./supplier-payment-evidence.service";

@Controller("purchasing/payment-evidence")
export class SupplierPaymentEvidenceController {
  constructor(private readonly evidence: SupplierPaymentEvidenceService) {}

  @RequirePermission("suppliers.pay")
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: PAYMENT_EVIDENCE_FILE_LIMIT, files: 1, fields: 2 },
    }),
  )
  @Post()
  upload(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Body("evidenceId") id: string,
    @Body("payment") raw: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    let payment: unknown;
    try {
      payment = JSON.parse(raw);
    } catch {
      throw new BadRequestException("Payment binding must be valid JSON.");
    }
    return this.evidence.upload(user, branchId, id, payment, file);
  }

  @RequirePermission("suppliers.pay")
  @Header("Cache-Control", "private, no-store")
  @Get(":id")
  async read(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    const row = await this.evidence.read(user, branchId, id);
    const extension =
      {
        "application/pdf": "pdf",
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/webp": "webp",
      }[row.mediaType] ?? "bin";
    return new StreamableFile(Buffer.from(row.content), {
      type: row.mediaType,
      disposition: `attachment; filename="payment-evidence-${id}.${extension}"`,
    });
  }

  @RequirePermission("suppliers.pay")
  @Post(":id/revoke")
  revoke(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !("reason" in body)
    )
      throw new BadRequestException("A revocation reason is required.");
    return this.evidence.revoke(
      user,
      branchId,
      id,
      (body as { reason: string }).reason,
    );
  }
}
