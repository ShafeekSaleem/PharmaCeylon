import { OperationalAuthorizationModule } from "../security/operational-authorization.module";
import { Module } from "@nestjs/common";
import { StocktakesController } from "./stocktakes.controller";
import { StocktakesService } from "./stocktakes.service";

@Module({
  imports: [OperationalAuthorizationModule],
  controllers: [StocktakesController],
  providers: [StocktakesService],
})
export class StocktakesModule {}
