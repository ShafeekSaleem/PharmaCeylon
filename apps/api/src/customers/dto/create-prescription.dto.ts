import {
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from "class-validator";

export class CreatePrescriptionDto {
  /** Optional — the API allocates `RX-#####` per branch when omitted. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  rxNumber?: string;

  @IsString()
  @MinLength(2)
  @MaxLength(160)
  patientName!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(160)
  doctorName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  doctorRegNo?: string;

  @IsDateString()
  issuedOn!: string;

  @IsOptional()
  @IsDateString()
  validUntil?: string;

  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  notes?: string;
}
