import { Module } from "@nestjs/common";
import { OperationalAuthorizationModule } from "../security/operational-authorization.module";
import { TerminalsModule } from "../terminals/terminals.module";
import { JournalReviewsController } from "./journal-reviews.controller";
import { JournalReviewsService } from "./journal-reviews.service";

/** P5 #51 slice 4: review and settlement of refused offline journal entries (remote). */
@Module({
  imports: [OperationalAuthorizationModule, TerminalsModule],
  controllers: [JournalReviewsController],
  providers: [JournalReviewsService],
})
export class JournalReviewsModule {}
