import { Module } from "@nestjs/common";
import { LocalAttendanceVerifier } from "./local-attendance.verifier";
import { OfflineAssignmentController } from "./offline-assignment.controller";
import { OfflineAssignmentService } from "./offline-assignment.service";
import { TerminalTrustService } from "./terminal-trust.service";

@Module({
  controllers: [OfflineAssignmentController],
  providers: [LocalAttendanceVerifier, TerminalTrustService, OfflineAssignmentService],
  exports: [TerminalTrustService, LocalAttendanceVerifier, OfflineAssignmentService],
})
export class TerminalsModule {}
