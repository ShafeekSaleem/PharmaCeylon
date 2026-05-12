import { Global, Module } from "@nestjs/common";
import { AuditEventsController } from "./audit-events.controller";
import { AuditService } from "./audit.service";

@Global()
@Module({
  controllers: [AuditEventsController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
