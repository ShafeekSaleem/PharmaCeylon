import { Module } from "@nestjs/common";
import { ProductsModule } from "../products/products.module";
import { SetupController } from "./setup.controller";
import { SetupReadinessService } from "./setup-readiness.service";

@Module({
  imports: [ProductsModule],
  controllers: [SetupController],
  providers: [SetupReadinessService],
  exports: [SetupReadinessService],
})
export class SetupModule {}
