import { Module } from "@nestjs/common";
import { HeldSalesService } from "./held-sales.service";
import { PosService } from "./pos.service";
import { SalesController } from "./sales.controller";
import { SalesService } from "./sales.service";

@Module({
  controllers: [SalesController],
  providers: [SalesService, PosService, HeldSalesService],
})
export class SalesModule {}
