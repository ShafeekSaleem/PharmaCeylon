import { Module } from "@nestjs/common";
import { ProductMetaController } from "./product-meta.controller";
import { ProductMetaService } from "./product-meta.service";
import { ProductsController } from "./products.controller";
import { ProductsService } from "./products.service";

@Module({
  controllers: [ProductMetaController, ProductsController],
  providers: [ProductsService, ProductMetaService],
  exports: [ProductsService, ProductMetaService],
})
export class ProductsModule {}
