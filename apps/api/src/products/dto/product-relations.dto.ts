import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

export class ProductRelationsDto {
  @IsOptional()
  @IsArray()
  @IsUUID("4", { each: true })
  categoryIds?: string[];

  @IsOptional()
  @IsArray()
  @IsUUID("4", { each: true })
  tagIds?: string[];
}

export class CreateProductCategoryDto {
  @IsString()
  @MaxLength(128)
  name!: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  parentCategoryId?: string | null;
}

export class UpdateProductCategoryDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  name?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  parentCategoryId?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

class ReorderCategoryItemDto {
  @IsUUID()
  id!: string;

  @IsInt()
  @Min(0)
  sortOrder!: number;
}

export class ReorderCategoriesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReorderCategoryItemDto)
  items!: ReorderCategoryItemDto[];
}

export class MoveProductsCategoryDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID("4", { each: true })
  productIds!: string[];

  @IsUUID()
  toCategoryId!: string;
}

export class OnboardingSelectionDto {
  @IsArray()
  @IsString({ each: true })
  departments!: string[];
}

export class CreateProductTagDto {
  @IsString()
  @MaxLength(64)
  name!: string;
}

export class UpdateProductTagDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  name?: string;
}

export class CreateProductAliasDto {
  @IsString()
  @MaxLength(256)
  aliasText!: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  aliasType?: string;
}
