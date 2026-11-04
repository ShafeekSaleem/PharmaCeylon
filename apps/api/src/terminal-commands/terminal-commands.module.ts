import { Module } from "@nestjs/common";
import { InventoryModule } from "../inventory/inventory.module";
import { ProductImportModule } from "../product-import/product-import.module";
import { PurchasingModule } from "../purchasing/purchasing.module";
import { ReturnsModule } from "../returns/returns.module";
import { OperationalAuthorizationModule } from "../security/operational-authorization.module";
import { StocktakesModule } from "../stocktakes/stocktakes.module";
import { TerminalsModule } from "../terminals/terminals.module";
import { TransfersModule } from "../transfers/transfers.module";
import { CustomersModule } from "../customers/customers.module";
import { SalesModule } from "../sales/sales.module";
import { CounterWorkController } from "./counter-work.controller";
import { CounterWorkService } from "./counter-work.service";
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
    SalesModule,
    ReturnsModule,
    CustomersModule,
  ],
  controllers: [TerminalCommandsController, CounterWorkController],
  providers: [TerminalCommandExecutor, SignedOperations, CounterWorkService],
})
export class TerminalCommandsModule {}
