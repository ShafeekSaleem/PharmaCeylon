import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CategoryTaxonomyOps } from "./category-taxonomy.util";

export type { RegulatoryDimension } from "./category-taxonomy.util";

/** Nest DI wrapper around `CategoryTaxonomyOps` — see that file for the actual logic. */
@Injectable()
export class CategoryTaxonomyService extends CategoryTaxonomyOps {
  constructor(prisma: PrismaService) {
    super(prisma);
  }
}
