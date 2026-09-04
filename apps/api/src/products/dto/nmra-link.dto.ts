import { Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsUUID, ValidateNested } from "class-validator";
import { FILL_IF_EMPTY_FIELD_NAMES } from "../product-nmra-link.util";

/** Body shared by preview and apply — same shape, so the preview shown is exactly what applying does. */
export class NmraLinkDto {
  @IsUUID()
  referenceProductId!: string;

  /** Force-adopt the register's value for one of the "fill only if empty" fields even though
   *  the shop's product already has one. Compliance flags and the register-always fields are
   *  never in this list — they are not overridable. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(FILL_IF_EMPTY_FIELD_NAMES.length)
  @IsIn(FILL_IF_EMPTY_FIELD_NAMES, { each: true })
  adoptFieldOverrides?: string[];
}

export class NmraBulkLinkPair {
  @IsUUID()
  productId!: string;

  @IsUUID()
  referenceProductId!: string;
}

export class NmraBulkLinkDto {
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => NmraBulkLinkPair)
  links!: NmraBulkLinkPair[];
}
