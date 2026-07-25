import {
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from "class-validator";

export class UpdateStocktakeDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;
}

export class AddStocktakeLinesDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID("4", { each: true })
  batchIds!: string[];
}

export class RemoveStocktakeLinesDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID("4", { each: true })
  batchIds!: string[];
}
