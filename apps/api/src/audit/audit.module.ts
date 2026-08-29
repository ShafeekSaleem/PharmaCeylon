import { Global, Module } from "@nestjs/common";
import { AuditEventsController } from "./audit-events.controller";
import { AuditSummaryController } from "./audit-summary.controller";
import { AuditService } from "./audit.service";

@Global()
@Module({
  controllers: [AuditEventsController, AuditSummaryController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
