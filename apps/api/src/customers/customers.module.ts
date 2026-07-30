import { Module } from "@nestjs/common";
import { CustomersController } from "./customers.controller";
import { CustomersService } from "./customers.service";
import { PrescriptionsController } from "./prescriptions.controller";
import { PrescriptionsService } from "./prescriptions.service";

@Module({
  controllers: [CustomersController, PrescriptionsController],
  providers: [CustomersService, PrescriptionsService],
  exports: [CustomersService, PrescriptionsService],
})
export class CustomersModule {}
