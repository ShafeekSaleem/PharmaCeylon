import { Module } from "@nestjs/common";
import { BusinessHoursAcknowledgements } from "./business-hours-acknowledgements.service";
import { LocalAttendanceVerifier } from "./local-attendance.verifier";
import { OperatingHoursEvidence } from "./operating-hours.evidence";
import { TerminalTrustService } from "./terminal-trust.service";

@Module({
  providers: [
    LocalAttendanceVerifier,
    TerminalTrustService,
    OperatingHoursEvidence,
    BusinessHoursAcknowledgements,
  ],
  exports: [
    TerminalTrustService,
    LocalAttendanceVerifier,
    OperatingHoursEvidence,
    BusinessHoursAcknowledgements,
  ],
})
export class TerminalsModule {}
