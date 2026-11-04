import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { NotificationsModule } from "../notifications/notifications.module";
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
import { PinAlerts } from "./pin-alerts.service";
import { PinSignInService } from "./pin-sign-in.service";
import { StaffCredentialsService } from "./staff-credentials.service";
import { TerminalEnrollmentController } from "./terminal-enrollment.controller";
import { TerminalEnrollmentService } from "./terminal-enrollment.service";
import { TerminalTrustService } from "./terminal-trust.service";
import { TillShiftsController } from "./shifts/till-shifts.controller";
import { TillShiftsService } from "./shifts/till-shifts.service";

@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [
    OfflineAssignmentController,
    OfflineActivationController,
    TerminalEnrollmentController,
    EnrollmentCodesController,
    TillShiftsController,
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
    PinSignInService,
    PinAlerts,
    EnrollmentCodesService,
    OfflineActivationClearance,
    OfflineActivationService,
    TillShiftsService,
  ],
  exports: [
    TerminalTrustService,
    LocalAttendanceVerifier,
    OperatingHoursEvidence,
    BusinessHoursAcknowledgements,
    OfflineSupportRecords,
    OfflineAssignmentService,
    PinAlerts,
    TillShiftsService,
  ],
})
export class TerminalsModule {}
