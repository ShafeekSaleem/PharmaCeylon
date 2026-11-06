import { Module } from "@nestjs/common";
import { OperationalAuthorizationModule } from "../security/operational-authorization.module";
import { StockCasesController } from "./stock-cases.controller";
import { StockCasesService } from "./stock-cases.service";

/** P5 #51 slice 2: review, plan, approve (remote) and the counter's execution core. */
@Module({
  imports: [OperationalAuthorizationModule],
  controllers: [StockCasesController],
  providers: [StockCasesService],
  exports: [StockCasesService],
})
export class StockCasesModule {}
