import { Module } from "@nestjs/common";
import { HeldSalesService } from "./held-sales.service";
import { PharmacistApprovalService } from "./pharmacist-approval.service";
import { PosService } from "./pos.service";
import { SalesController } from "./sales.controller";
import { SalesService } from "./sales.service";

@Module({
  controllers: [SalesController],
  providers: [SalesService, PosService, HeldSalesService, PharmacistApprovalService],
})
export class SalesModule {}
