"use client";

import Link from "next/link";
import { IconAlertTriangle, IconChevronRight } from "@/components/icons";
import type { CatalogTaskSummary } from "../api/catalog-tasks";
import css from "../products.module.css";

/**
 * One line, shown only when there is something to do: how much catalog work is outstanding and
 * what it consists of.
 *
 * This is what replaced the five KPI cards. Those were on screen permanently, restating counts
 * the tabs and filter chips already carried, and they said nothing about whether anything
 * needed attention — a shop with a spotless catalog and one drowning in unfiled products saw
 * the same wall of tiles. A banner that is usually absent is more informative than five cards
 * that are always present.
 */
export function CatalogIssueBanner({
  summary,
  href = "/products/manage",
}: {
  summary: CatalogTaskSummary | null;
  href?: string;
}) {
  if (!summary || summary.open === 0) return null;

  /*
   * Only break the total down when the breakdown says something the total didn't. With a
   * single kind of task outstanding this used to read "213 products need catalog review: 213
   * missing a category", which spends a clause restating the number it just gave.
   */
  const parts: string[] = [];
  if (summary.needsCategory > 0) {
    parts.push(`${summary.needsCategory.toLocaleString()} missing a category`);
  }
  if (summary.nmraMatch > 0) {
    parts.push(
      `${summary.nmraMatch.toLocaleString()} possible NMRA match${summary.nmraMatch === 1 ? "" : "es"}`,
    );
  }
  if (summary.ambiguous > 0) {
    parts.push(`${summary.ambiguous.toLocaleString()} ambiguous`);
  }
  const breakdown = parts.length > 1 ? parts.join(", ") : null;

  return (
    <div className={css.issueBanner} role="status">
      <span className={css.issueBannerIcon} aria-hidden>
        <IconAlertTriangle size={15} />
      </span>
      <p className={css.issueBannerText}>
        <strong>
          {summary.open.toLocaleString()} product{summary.open === 1 ? "" : "s"} need
          {summary.open === 1 ? "s" : ""} catalog review
        </strong>
        {breakdown && <>: {breakdown}.</>}
        {summary.complianceReview > 0 && (
          <>
            {" "}
            {summary.complianceReview.toLocaleString()} would change a compliance flag and need
            {summary.complianceReview === 1 ? "s" : ""} individual review.
          </>
        )}
      </p>
      <Link className={css.issueBannerLink} href={href}>
        Review tasks
        <IconChevronRight size={14} />
      </Link>
    </div>
  );
}
