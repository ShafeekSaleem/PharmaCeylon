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
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { RequirePermission } from "../security/decorators/require-permission.decorator";
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

  @RequirePermission("nmra.import")
  @UseInterceptors(FileInterceptor("file", UPLOAD_LIMITS))
  @Post("preview")
  preview(
    @CurrentUser() user: RequestUser,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.nmraImport.preview(user.tenantId, file);
  }

  @RequirePermission("nmra.import")
  @UseInterceptors(FileInterceptor("file", UPLOAD_LIMITS))
  @Post("confirm")
  confirm(
    @CurrentUser() user: RequestUser,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.nmraImport.startUpsertJob(user.tenantId, user.userId, file);
  }

  @RequirePermission("nmra.import")
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

  @RequirePermission("nmra.import")
  @UseInterceptors(FileInterceptor("file", UPLOAD_LIMITS))
  @Post("import")
  importBarcodes(
    @CurrentUser() user: RequestUser,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.nmraImport.importBarcodes(user.tenantId, user.userId, file);
  }
}
