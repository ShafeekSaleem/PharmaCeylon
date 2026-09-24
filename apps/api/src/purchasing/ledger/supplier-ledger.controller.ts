import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from "@nestjs/common";
import { CurrentUser } from "../../security/decorators/current-user.decorator";
import { RequireBranchId } from "../../security/decorators/require-branch.decorator";
import { RequirePermission } from "../../security/decorators/require-permission.decorator";
import { RequestUser } from "../../security/interfaces/authenticated-request.interface";
import {
  ApplyDebitNoteDto,
  CreateSupplierInvoiceRecordDto,
  RecordSupplierPaymentLedgerDto,
  VoidDto,
} from "./supplier-ledger.dto";
import { SupplierLedgerService } from "./supplier-ledger.service";

/**
 * What the pharmacy owes its suppliers, and what it has paid.
 *
 * Money is its own permission pair, separate from buying stock: `purchasing.invoice` records
 * what a supplier billed, `suppliers.pay` records what went out. Both default to owners and
 * managers — the clerk who books a delivery in is not the person who settles the bill. Either
 * key is enough to read, because whoever pays needs to see the invoice and vice versa.
 */
@Controller("purchasing")
export class SupplierLedgerController {
  constructor(private readonly ledger: SupplierLedgerService) {}

  @RequirePermission("purchasing.invoice", "suppliers.pay")
  @Get("payables")
  payables(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
  ) {
    return this.ledger.payablesSummary(user.tenantId, branchId);
  }

  @RequirePermission("purchasing.invoice", "suppliers.pay")
  @Get("invoices")
  listInvoices(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query("supplierId") supplierId?: string,
    @Query("status") status?: string,
    @Query("source") source?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("q") q?: string,
  ) {
    return this.ledger.listInvoices(user.tenantId, branchId, {
      supplierId,
      status,
      source,
      from,
      to,
      q,
    });
  }

  @RequirePermission("purchasing.invoice")
  @Get("invoices/unbilled-deliveries")
  unbilledDeliveries(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query("supplierId", ParseUUIDPipe) supplierId: string,
  ) {
    return this.ledger.unbilledDeliveries(user.tenantId, branchId, supplierId);
  }

  @RequirePermission("purchasing.invoice", "suppliers.pay")
  @Get("invoices/:id")
  getInvoice(
    @CurrentUser() user: RequestUser,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.ledger.getInvoice(user.tenantId, id);
  }

  @RequirePermission("purchasing.invoice")
  @Post("invoices")
  createInvoice(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Body() dto: CreateSupplierInvoiceRecordDto,
  ) {
    return this.ledger.createInvoice(user.tenantId, branchId, user.userId, dto);
  }

  @RequirePermission("purchasing.invoice")
  @Post("invoices/:id/void")
  voidInvoice(
    @CurrentUser() user: RequestUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: VoidDto,
  ) {
    return this.ledger.voidInvoice(
      user.tenantId,
      user.userId,
      id,
      dto.reason.trim(),
    );
  }

  @RequirePermission("purchasing.invoice", "suppliers.pay")
  @Get("payments")
  listPayments(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query("supplierId") supplierId?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    return this.ledger.listPayments(user.tenantId, branchId, {
      supplierId,
      from,
      to,
    });
  }

  @RequirePermission("suppliers.pay")
  @Post("payments")
  recordPayment(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() dto: RecordSupplierPaymentLedgerDto,
  ) {
    return this.ledger.recordPayment(
      user.tenantId,
      branchId,
      user.userId,
      dto,
      idempotencyKey,
    );
  }

  @RequirePermission("suppliers.pay")
  @Post("payments/:id/void")
  voidPayment(
    @CurrentUser() user: RequestUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: VoidDto,
  ) {
    return this.ledger.voidPayment(
      user.tenantId,
      user.userId,
      id,
      dto.reason.trim(),
    );
  }

  @RequirePermission("purchasing.invoice", "suppliers.pay")
  @Get("debit-notes")
  listDebitNotes(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Query("supplierId") supplierId?: string,
    @Query("status") status?: string,
  ) {
    return this.ledger.listDebitNotes(user.tenantId, branchId, {
      supplierId,
      status,
    });
  }

  @RequirePermission("suppliers.pay")
  @Post("debit-notes/:id/apply")
  applyDebitNote(
    @CurrentUser() user: RequestUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: ApplyDebitNoteDto,
  ) {
    return this.ledger.applyDebitNote(user.tenantId, user.userId, id, dto);
  }

  @RequirePermission("purchasing.invoice")
  @Post("debit-notes/:id/void")
  voidDebitNote(
    @CurrentUser() user: RequestUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: VoidDto,
  ) {
    return this.ledger.voidDebitNote(
      user.tenantId,
      user.userId,
      id,
      dto.reason.trim(),
    );
  }
}
