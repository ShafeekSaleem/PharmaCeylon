import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from "@nestjs/common";
import { CatalogTaskStatus, CatalogTaskType } from "@prisma/client";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { RequirePermission } from "../security/decorators/require-permission.decorator";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { CatalogTaskService } from "./catalog-task.service";
import type { CatalogTaskFilter } from "./catalog-task.types";
import {
  ApplyCatalogTaskDto,
  ApplySafeCatalogTasksDto,
  CloseCatalogTaskDto,
  RefreshCatalogTasksDto,
} from "./dto/catalog-task.dto";

/**
 * The Catalog Management Work Queue.
 *
 * Reads take `products.view` and writes `products.manage`, exactly matching the two screens
 * this replaces (`/products/organize` and `/products/nmra-matches`) — consolidating the UI must
 * not quietly change who can do what.
 */
@Controller("catalog-tasks")
export class CatalogTaskController {
  constructor(private readonly tasks: CatalogTaskService) {}

  @RequirePermission("products.view")
  @Get("summary")
  summary(@CurrentUser() user: RequestUser) {
    return this.tasks.summary(user.tenantId);
  }

  @RequirePermission("products.view")
  @Get()
  list(
    @CurrentUser() user: RequestUser,
    @Query("status") status?: string,
    @Query("type") type?: string,
    @Query("view") view?: string,
    @Query("q") q?: string,
    @Query("importId") importId?: string,
    @Query("source") source?: string,
    @Query("createdFrom") createdFrom?: string,
    @Query("createdTo") createdTo?: string,
    @Query("skip") skip?: string,
    @Query("take") take?: string,
  ) {
    return this.tasks.list(
      user.tenantId,
      parseFilter({
        status,
        type,
        view,
        q,
        importId,
        source,
        createdFrom,
        createdTo,
        skip,
        take,
      }),
    );
  }

  /**
   * Recompute the queue. Cheap enough to call when the Work Queue is opened, which is what
   * keeps it current without a scheduler; the import pipeline also calls the service directly
   * with its own `importId`.
   */
  @RequirePermission("products.manage")
  @Post("refresh")
  refresh(
    @CurrentUser() user: RequestUser,
    @Body() dto: RefreshCatalogTasksDto,
  ) {
    return this.tasks.refresh(user.tenantId, { importId: dto.importId });
  }

  @RequirePermission("products.manage")
  @Post("apply-safe")
  applySafe(
    @CurrentUser() user: RequestUser,
    @Body() dto: ApplySafeCatalogTasksDto,
  ) {
    return this.tasks.applySafe(user.tenantId, user.userId, {
      status: dto.status,
      type: dto.type,
      view: dto.view,
      q: dto.q,
      importId: dto.importId,
      source: dto.source,
      createdFrom: dto.createdFrom,
      createdTo: dto.createdTo,
    });
  }

  @RequirePermission("products.view")
  @Get(":id")
  view(
    @CurrentUser() user: RequestUser,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.tasks.view(user.tenantId, id);
  }

  @RequirePermission("products.manage")
  @Post(":id/apply")
  apply(
    @CurrentUser() user: RequestUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: ApplyCatalogTaskDto,
  ) {
    return this.tasks.apply(user.tenantId, user.userId, id, {
      categoryId: dto.categoryId,
      referenceProductId: dto.referenceProductId,
    });
  }

  @RequirePermission("products.manage")
  @Post(":id/dismiss")
  dismiss(
    @CurrentUser() user: RequestUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: CloseCatalogTaskDto,
  ) {
    return this.tasks.dismiss(user.tenantId, user.userId, id, dto.note);
  }

  @RequirePermission("products.manage")
  @Post(":id/not-applicable")
  notApplicable(
    @CurrentUser() user: RequestUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: CloseCatalogTaskDto,
  ) {
    return this.tasks.markNotApplicable(
      user.tenantId,
      user.userId,
      id,
      dto.note,
    );
  }

  @RequirePermission("products.manage")
  @Post(":id/reopen")
  reopen(
    @CurrentUser() user: RequestUser,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.tasks.reopen(user.tenantId, user.userId, id);
  }
}

/**
 * Turn the URL's comma-separated, string-typed query into the service's filter.
 *
 * Unknown enum members are dropped rather than rejected: these values come straight from a
 * bookmarkable URL, and a stale link should degrade to a broader list, not a 400.
 */
export function parseFilter(raw: {
  status?: string;
  type?: string;
  view?: string;
  q?: string;
  importId?: string;
  source?: string;
  createdFrom?: string;
  createdTo?: string;
  skip?: string;
  take?: string;
}): CatalogTaskFilter {
  const statuses = splitEnum(raw.status, Object.values(CatalogTaskStatus));
  const types = splitEnum(raw.type, Object.values(CatalogTaskType));
  const from = raw.createdFrom ? new Date(raw.createdFrom) : undefined;
  const to = raw.createdTo ? new Date(raw.createdTo) : undefined;

  return {
    status: statuses.length ? (statuses as CatalogTaskStatus[]) : undefined,
    type: types.length ? (types as CatalogTaskType[]) : undefined,
    view: raw.view,
    q: raw.q,
    importId: raw.importId,
    source: raw.source,
    createdFrom: from && !Number.isNaN(from.getTime()) ? from : undefined,
    createdTo: to && !Number.isNaN(to.getTime()) ? to : undefined,
    skip: toInt(raw.skip),
    take: toInt(raw.take),
  };
}

function splitEnum(value: string | undefined, allowed: string[]): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((v) => v.trim().toUpperCase())
    .filter((v) => allowed.includes(v));
}

function toInt(value: string | undefined): number | undefined {
  if (value == null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
