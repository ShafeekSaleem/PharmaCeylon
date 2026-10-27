import { Module } from "@nestjs/common";
import { SalesModule } from "../sales/sales.module";
import { SearchController } from "./search.controller";
import { SearchService } from "./search.service";

@Module({
  imports: [SalesModule],
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}
