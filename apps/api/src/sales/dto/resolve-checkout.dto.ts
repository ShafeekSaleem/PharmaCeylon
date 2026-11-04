import { IsString, IsUUID, MaxLength, MinLength } from "class-validator";

/** An earlier checkout from this counter that never got an answer, as the counter recorded it. */
export class ResolveCheckoutDto {
  /** The `Idempotency-Key` the original checkout was sent with. */
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  idempotencyKey!: string;

  /** The staff session the original checkout was sent under (`x-terminal-session`). */
  @IsUUID()
  workSessionId!: string;
}
