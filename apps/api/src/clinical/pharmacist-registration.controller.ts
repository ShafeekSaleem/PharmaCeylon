import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { RequireBranchId } from "../security/decorators/require-branch.decorator";
import { RequirePermission } from "../security/decorators/require-permission.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { RecordPharmacistRegistrationDto, RevokePharmacistRegistrationDto } from "./dto/pharmacist-registration.dto";
import { PharmacistRegistrationService } from "./pharmacist-registration.service";

/** P1 #47 clinical qualification (contract: docs/API_CONTRACT.md "Pharmacist registrations").
 * `users.view` / `users.manage` only gate the routes: recording and revoking additionally need a
 * live owner in the service. Remote management; none of these routes dispenses anything.
 */
@ApiTags("admin")
@Controller("admin/pharmacist-registrations")
export class PharmacistRegistrationController {
  constructor(private readonly registrations: PharmacistRegistrationService) {}

  @RequirePermission("users.view")
  @Get()
  list(@CurrentUser() user: RequestUser) {
    return this.registrations.list(user);
  }

  @RequirePermission("users.manage")
  @Post()
  @HttpCode(200)
  record(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Body() dto: RecordPharmacistRegistrationDto,
  ) {
    return this.registrations.record(user, branchId, dto);
  }

  @RequirePermission("users.manage")
  @Post(":registrationId/revoke")
  @HttpCode(200)
  revoke(
    @CurrentUser() user: RequestUser,
    @RequireBranchId() branchId: string,
    @Param("registrationId", ParseUUIDPipe) registrationId: string,
    @Body() dto: RevokePharmacistRegistrationDto,
  ) {
    return this.registrations.revoke(user, branchId, registrationId, dto.reason);
  }
}
