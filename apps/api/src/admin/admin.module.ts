import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { AdminUsersController } from "./admin-users.controller";
import { AdminUsersService } from "./admin-users.service";
import { RolesAdminController } from "./roles-admin.controller";
import { RolesAdminService } from "./roles-admin.service";

@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [AdminUsersController, RolesAdminController],
  providers: [AdminUsersService, RolesAdminService],
})
export class AdminModule {}
