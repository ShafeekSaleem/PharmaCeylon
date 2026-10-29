import { Module } from "@nestjs/common";
import { InventoryModule } from "../inventory/inventory.module";
import { ProductImportModule } from "../product-import/product-import.module";
import { PurchasingModule } from "../purchasing/purchasing.module";
import { ReturnsModule } from "../returns/returns.module";
import { OperationalAuthorizationModule } from "../security/operational-authorization.module";
import { StocktakesModule } from "../stocktakes/stocktakes.module";
import { TerminalsModule } from "../terminals/terminals.module";
import { TransfersModule } from "../transfers/transfers.module";
import { SignedOperations } from "./signed-operations";
import { TerminalCommandsController } from "./terminal-commands.controller";
import { TerminalCommandExecutor } from "./terminal-command.executor";

@Module({
  imports: [
    TerminalsModule,
    OperationalAuthorizationModule,
    StocktakesModule,
    InventoryModule,
    PurchasingModule,
    ProductImportModule,
    TransfersModule,
    ReturnsModule,
  ],
  controllers: [TerminalCommandsController],
  providers: [TerminalCommandExecutor, SignedOperations],
})
export class TerminalCommandsModule {}
