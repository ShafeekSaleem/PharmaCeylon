import { IsString, MaxLength, MinLength } from "class-validator";

export class QuarantineBatchDto {
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  reason!: string;
}
