import { Module } from "@nestjs/common";
import { BusinessHoursAcknowledgements } from "./business-hours-acknowledgements.service";
import { LocalAttendanceVerifier } from "./local-attendance.verifier";
import { OfflineAssignmentController } from "./offline-assignment.controller";
import { OfflineAssignmentService } from "./offline-assignment.service";
import { OfflineSupportRecords } from "./offline-support-records.service";
import { OperatingHoursEvidence } from "./operating-hours.evidence";
import { TerminalTrustService } from "./terminal-trust.service";

@Module({
  controllers: [OfflineAssignmentController],
  providers: [
    LocalAttendanceVerifier,
    TerminalTrustService,
    OperatingHoursEvidence,
    BusinessHoursAcknowledgements,
    OfflineSupportRecords,
    OfflineAssignmentService,
  ],
  exports: [
    TerminalTrustService,
    LocalAttendanceVerifier,
    OperatingHoursEvidence,
    BusinessHoursAcknowledgements,
    OfflineSupportRecords,
    OfflineAssignmentService,
  ],
})
export class TerminalsModule {}
