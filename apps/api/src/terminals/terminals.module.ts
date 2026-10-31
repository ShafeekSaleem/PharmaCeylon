import { Module } from "@nestjs/common";
import { AttendanceProofsService } from "./attendance-proofs.service";
import { BusinessHoursAcknowledgements } from "./business-hours-acknowledgements.service";
import { LocalAttendanceVerifier } from "./local-attendance.verifier";
import { OfflineAssignmentController } from "./offline-assignment.controller";
import { OfflineAssignmentService } from "./offline-assignment.service";
import { OperatingHoursEvidence } from "./operating-hours.evidence";
import { StaffCredentialsService } from "./staff-credentials.service";
import { TerminalEnrollmentController } from "./terminal-enrollment.controller";
import { TerminalEnrollmentService } from "./terminal-enrollment.service";
import { TerminalTrustService } from "./terminal-trust.service";

@Module({
  controllers: [OfflineAssignmentController, TerminalEnrollmentController],
  providers: [
    LocalAttendanceVerifier,
    TerminalTrustService,
    OperatingHoursEvidence,
    BusinessHoursAcknowledgements,
    OfflineAssignmentService,
    AttendanceProofsService,
    TerminalEnrollmentService,
    StaffCredentialsService,
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
