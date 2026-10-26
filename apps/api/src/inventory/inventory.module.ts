import { OperationalAuthorizationModule } from "../security/operational-authorization.module";
import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module";
import { AdjustmentService } from "./adjustment.service";
import { InventoryController } from "./inventory.controller";
import { InventoryService } from "./inventory.service";

@Module({
  imports: [NotificationsModule, OperationalAuthorizationModule],
  controllers: [InventoryController],
  providers: [InventoryService, AdjustmentService],
  exports: [InventoryService],
})
export class InventoryModule {}
