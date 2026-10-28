import { Module } from "@nestjs/common";
import { OperationalAuthorizationModule } from "../security/operational-authorization.module";
import { TransfersController } from "./transfers.controller";
import { TransfersService } from "./transfers.service";

@Module({
  imports: [OperationalAuthorizationModule],
  controllers: [TransfersController],
  providers: [TransfersService],
  exports: [TransfersService],
})
export class TransfersModule {}
