import { Global, Module } from "@nestjs/common";
import { TaxService } from "./tax.service";

@Global()
@Module({
  providers: [TaxService],
  exports: [TaxService],
})
export class PricingModule {}
