"use client";

import Link from "next/link";
import pageCss from "../../settings.module.css";

/** Categories and tags share one settings area — this switcher ties the two pages together
 *  so they read as one organized section instead of two unrelated routes. */
export function CatalogMetaTabs({ active }: { active: "categories" | "tags" }) {
  return (
    <div className={pageCss.pillRow} role="tablist" aria-label="Categories and tags">
      <Link
        href="/settings/catalog/categories"
        role="tab"
        aria-selected={active === "categories"}
        className={`${pageCss.pill}${active === "categories" ? ` ${pageCss.pillSelected}` : ""}`}
      >
        Categories
      </Link>
      <Link
        href="/settings/catalog/tags"
        role="tab"
        aria-selected={active === "tags"}
        className={`${pageCss.pill}${active === "tags" ? ` ${pageCss.pillSelected}` : ""}`}
      >
        Tags
      </Link>
    </div>
  );
}
