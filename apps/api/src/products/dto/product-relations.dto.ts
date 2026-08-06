import {
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from "class-validator";

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
