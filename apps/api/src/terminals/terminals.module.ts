import { Module } from "@nestjs/common";
import { BusinessHoursAcknowledgements } from "./business-hours-acknowledgements.service";
import { LocalAttendanceVerifier } from "./local-attendance.verifier";
import { OfflineAssignmentController } from "./offline-assignment.controller";
import { OfflineAssignmentService } from "./offline-assignment.service";
import { OperatingHoursEvidence } from "./operating-hours.evidence";
import { TerminalTrustService } from "./terminal-trust.service";

@Module({
  controllers: [OfflineAssignmentController],
  providers: [
    LocalAttendanceVerifier,
    TerminalTrustService,
    OperatingHoursEvidence,
    BusinessHoursAcknowledgements,
    OfflineAssignmentService,
  ],
  exports: [
    TerminalTrustService,
    LocalAttendanceVerifier,
    OperatingHoursEvidence,
    BusinessHoursAcknowledgements,
    OfflineAssignmentService,
  ],
})
export class TerminalsModule {}
