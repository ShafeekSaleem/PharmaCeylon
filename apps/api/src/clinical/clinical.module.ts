import { Module } from "@nestjs/common";
import { PharmacistRegistrationController } from "./pharmacist-registration.controller";
import { PharmacistRegistrationService } from "./pharmacist-registration.service";

@Module({
  controllers: [PharmacistRegistrationController],
  providers: [PharmacistRegistrationService],
  exports: [PharmacistRegistrationService],
})
export class ClinicalModule {}
