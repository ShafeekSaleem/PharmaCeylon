import { Module } from "@nestjs/common";
import { AttendanceProofsService } from "./attendance-proofs.service";
import { BusinessHoursAcknowledgements } from "./business-hours-acknowledgements.service";
import { EnrollmentCodesController } from "./enrollment-codes.controller";
import { EnrollmentCodesService } from "./enrollment-codes.service";
import { LocalAttendanceVerifier } from "./local-attendance.verifier";
import { OfflineActivationController } from "./offline-activation.controller";
import { OfflineActivationClearance, OfflineActivationService } from "./offline-activation.service";
import { OfflineAssignmentController } from "./offline-assignment.controller";
import { OfflineAssignmentService } from "./offline-assignment.service";
import { OfflineSupportRecords } from "./offline-support-records.service";
import { OperatingHoursEvidence } from "./operating-hours.evidence";
import { StaffCredentialsService } from "./staff-credentials.service";
import { TerminalEnrollmentController } from "./terminal-enrollment.controller";
import { TerminalEnrollmentService } from "./terminal-enrollment.service";
import { TerminalTrustService } from "./terminal-trust.service";

@Module({
  controllers: [
    OfflineAssignmentController,
    OfflineActivationController,
    TerminalEnrollmentController,
    EnrollmentCodesController,
  ],
  providers: [
    LocalAttendanceVerifier,
    TerminalTrustService,
    OperatingHoursEvidence,
    BusinessHoursAcknowledgements,
    OfflineSupportRecords,
    OfflineAssignmentService,
    AttendanceProofsService,
    TerminalEnrollmentService,
    StaffCredentialsService,
    EnrollmentCodesService,
    OfflineActivationClearance,
    OfflineActivationService,
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
