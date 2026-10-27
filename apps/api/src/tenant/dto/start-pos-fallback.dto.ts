import { IsISO8601, IsOptional, IsString, MaxLength } from "class-validator";

export class StartPosFallbackDto {
  /** When the web POS fallback ends on its own. */
  @IsISO8601()
  endsAt!: string;

  /** Why the counters can't sell, kept with the audit event. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
