import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { AdminUsersController } from "./admin-users.controller";
import { AdminUsersService } from "./admin-users.service";
import { RolesAdminController } from "./roles-admin.controller";
import { RolesAdminService } from "./roles-admin.service";
import { StaffInvitationsController } from "./staff-invitations.controller";
import { StaffInvitationsService } from "./staff-invitations.service";

@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [AdminUsersController, RolesAdminController, StaffInvitationsController],
  providers: [AdminUsersService, RolesAdminService, StaffInvitationsService],
})
export class AdminModule {}
