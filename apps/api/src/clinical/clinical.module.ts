import { Module } from "@nestjs/common";
import { PharmacistRegistrationController } from "./pharmacist-registration.controller";
import { PharmacistCosignService } from "./pharmacist-cosign.service";
import { PharmacistRegistrationService } from "./pharmacist-registration.service";

@Module({
  controllers: [PharmacistRegistrationController],
  providers: [PharmacistRegistrationService, PharmacistCosignService],
  exports: [PharmacistRegistrationService, PharmacistCosignService],
})
export class ClinicalModule {}
