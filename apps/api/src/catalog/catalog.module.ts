import { Module } from "@nestjs/common";
import { CatalogController } from "./catalog.controller";
import { CatalogService } from "./catalog.service";
import { CategoryTaxonomyService } from "./category-taxonomy.service";

@Module({
  controllers: [CatalogController],
  providers: [CatalogService, CategoryTaxonomyService],
  exports: [CategoryTaxonomyService],
})
export class CatalogModule {}
