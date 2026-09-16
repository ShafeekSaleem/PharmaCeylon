import { Global, Module } from "@nestjs/common";
import { StockReadService } from "./stock-read.service";
import { StockService } from "./stock.service";

/**
 * Global for the same reason as `AuditModule`: sales, purchasing, transfers, returns,
 * stocktakes, imports and inventory all move stock, and every one of them must use the same
 * `StockService` rather than reach for the ledger directly.
 */
@Global()
@Module({
  providers: [StockService, StockReadService],
  exports: [StockService, StockReadService],
})
export class StockModule {}
