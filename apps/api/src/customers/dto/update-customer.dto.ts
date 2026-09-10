import {
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";

/**
 * Every field is optional — a partial update. `null` on a nullable field clears
 * it, which is why the optional strings accept null rather than only undefined:
 * "remove this customer's email" and "don't touch the email" are different
 * requests and the counter needs both.
 */
export class UpdateCustomerDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  fullName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string | null;

  @IsOptional()
  @IsEmail()
  email?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  address?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  notes?: string | null;

  /** Deactivating hides the customer from counter pickers without deleting the
   *  sales history attached to them. */
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
