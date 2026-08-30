import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  Req,
} from "@nestjs/common";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import {
  AuthenticatedRequest,
  RequestUser,
} from "../security/interfaces/authenticated-request.interface";
import { ListNotificationsDto } from "./dto/list-notifications.dto";
import { UpdateNotificationPreferencesDto } from "./dto/update-notification-preferences.dto";
import { NotificationsService } from "./notifications.service";

@Controller("notifications")
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(
    @CurrentUser() user: RequestUser,
    @Req() req: AuthenticatedRequest,
    @Query() query: ListNotificationsDto,
  ) {
    return this.notifications.list(user, req.branchId, query);
  }

  @Get("unread-count")
  unreadCount(
    @CurrentUser() user: RequestUser,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.notifications.unreadCount(user, req.branchId);
  }

  @Get("preferences")
  preferences(@CurrentUser() user: RequestUser) {
    return this.notifications.getPreferences(user.tenantId, user.userId);
  }

  @Patch("preferences")
  updatePreferences(
    @CurrentUser() user: RequestUser,
    @Body() dto: UpdateNotificationPreferencesDto,
  ) {
    return this.notifications.updatePreferences(
      user.tenantId,
      user.userId,
      dto,
    );
  }

  @Patch("read-all")
  markAllRead(
    @CurrentUser() user: RequestUser,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.notifications.markAllRead(
      user.tenantId,
      user.userId,
      req.branchId,
    );
  }

  @Patch(":id/read")
  markRead(
    @CurrentUser() user: RequestUser,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.notifications.markRead(user.tenantId, user.userId, id);
  }

  @Patch(":id/archive")
  archive(
    @CurrentUser() user: RequestUser,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.notifications.archive(user.tenantId, user.userId, id);
  }
}
