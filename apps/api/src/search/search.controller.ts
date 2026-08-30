import { Controller, Get, Query, Req } from "@nestjs/common";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import {
  AuthenticatedRequest,
  RequestUser,
} from "../security/interfaces/authenticated-request.interface";
import { GlobalSearchDto } from "./dto/global-search.dto";
import { SearchService } from "./search.service";

@Controller("search")
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  globalSearch(
    @CurrentUser() user: RequestUser,
    @Req() req: AuthenticatedRequest,
    @Query() query: GlobalSearchDto,
  ) {
    return this.search.globalSearch(user, req.branchId, query.q, query.limit);
  }
}
