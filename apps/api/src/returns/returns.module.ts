import { Module } from "@nestjs/common";
import { OperationalAuthorizationModule } from "../security/operational-authorization.module";
import { ReturnsController } from "./returns.controller";
import { ReturnsService } from "./returns.service";

@Module({
  imports: [OperationalAuthorizationModule],
  controllers: [ReturnsController],
  providers: [ReturnsService],
  exports: [ReturnsService],
})
export class ReturnsModule {}
