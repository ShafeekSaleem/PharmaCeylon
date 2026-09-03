import { Module } from "@nestjs/common";
import { SetupController } from "./setup.controller";
import { SetupReadinessService } from "./setup-readiness.service";

@Module({
  controllers: [SetupController],
  providers: [SetupReadinessService],
  exports: [SetupReadinessService],
})
export class SetupModule {}
