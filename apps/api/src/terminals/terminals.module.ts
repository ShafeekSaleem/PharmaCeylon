import { Module } from "@nestjs/common";
import { LocalAttendanceVerifier } from "./local-attendance.verifier";
import { TerminalTrustService } from "./terminal-trust.service";

@Module({
  providers: [LocalAttendanceVerifier, TerminalTrustService],
  exports: [TerminalTrustService, LocalAttendanceVerifier],
})
export class TerminalsModule {}
