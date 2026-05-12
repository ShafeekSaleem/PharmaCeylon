import { Module } from "@nestjs/common";
import { InventoryController } from "./inventory.controller";
import { InventoryService } from "./inventory.service";
import { StockBalanceService } from "./stock-balance.service";

@Module({
  controllers: [InventoryController],
  providers: [InventoryService, StockBalanceService],
  exports: [InventoryService, StockBalanceService],
})
export class InventoryModule {}
