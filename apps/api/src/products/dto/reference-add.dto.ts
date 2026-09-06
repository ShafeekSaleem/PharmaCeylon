import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsUUID,
} from "class-validator";

/**
 * "Add to my products" over NMRA reference rows.
 *
 * Same body for the preview and the apply, so the warnings the operator was shown are computed
 * from exactly the request that is about to be performed.
 */
export class ReferenceAddDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsUUID("4", { each: true })
  referenceProductIds!: string[];

  /**
   * The operator has seen and accepted the duplicate/compliance warnings from the preview.
   * Without it, any flagged row is held back rather than added — which is what stops a UI that
   * forgets to show the review from silently creating duplicate products.
   */
  @IsOptional()
  @IsBoolean()
  acknowledgeWarnings?: boolean;
}

/** "Stop selling these" — the policy decides per product whether that means unrange or deactivate. */
export class RangeExitDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsUUID("4", { each: true })
  productIds!: string[];
}
