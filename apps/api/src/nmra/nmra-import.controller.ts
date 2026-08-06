/// <reference types="multer" />
import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { RoleName } from "@prisma/client";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { Roles } from "../security/decorators/roles.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { NmraImportService } from "./nmra-import.service";

const UPLOAD_LIMITS = { limits: { fileSize: 40 * 1024 * 1024 } };

/**
 * NMRA Valid Registration import.
 * Download the official Valid Registration Excel from NMRA, then upload here
 * (file upload is the primary path — no fragile website scrape).
 *
 * Confirm starts an in-memory job and returns { jobId }; poll GET jobs/:jobId.
 */
@Controller("products/nmra-import")
export class NmraImportController {
  constructor(private readonly nmraImport: NmraImportService) {}

  @Roles(RoleName.owner, RoleName.manager, RoleName.inventory_clerk)
  @UseInterceptors(FileInterceptor("file", UPLOAD_LIMITS))
  @Post("preview")
  preview(
    @CurrentUser() user: RequestUser,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.nmraImport.preview(user.tenantId, file);
  }

  @Roles(RoleName.owner, RoleName.manager, RoleName.inventory_clerk)
  @UseInterceptors(FileInterceptor("file", UPLOAD_LIMITS))
  @Post("confirm")
  confirm(
    @CurrentUser() user: RequestUser,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.nmraImport.startUpsertJob(user.tenantId, user.userId, file);
  }

  @Roles(RoleName.owner, RoleName.manager, RoleName.inventory_clerk)
  @Get("jobs/:jobId")
  jobProgress(
    @CurrentUser() user: RequestUser,
    @Param("jobId", ParseUUIDPipe) jobId: string,
  ) {
    return this.nmraImport.getJobProgress(user.tenantId, jobId);
  }
}

@Controller("products/barcodes")
export class BarcodeImportController {
  constructor(private readonly nmraImport: NmraImportService) {}

  @Roles(RoleName.owner, RoleName.manager, RoleName.inventory_clerk)
  @UseInterceptors(FileInterceptor("file", UPLOAD_LIMITS))
  @Post("import")
  importBarcodes(
    @CurrentUser() user: RequestUser,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.nmraImport.importBarcodes(user.tenantId, user.userId, file);
  }
}
