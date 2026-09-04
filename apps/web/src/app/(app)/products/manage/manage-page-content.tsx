"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { IconChevronLeft, IconClipboardList, IconGrid, IconTag } from "@/components/icons";
import { PageHeader, SegmentedTabPanel, SegmentedTabs } from "@/components/ui";
import { usePageChrome } from "@/lib/page-chrome-context";
import { usePermissions } from "@/lib/permissions";
import { useCatalogTaskSummary } from "../hooks/use-catalog-task-summary";
import { CategoriesSection } from "./sections/categories-section";
import { TagsSection } from "./sections/tags-section";
import { WorkQueueSection, type WorkQueueViewId } from "./sections/work-queue-section";
import css from "./manage.module.css";

const SECTIONS = ["queue", "categories", "tags"] as const;
type SectionId = (typeof SECTIONS)[number];

function parseSection(raw: string | null): SectionId {
  return SECTIONS.includes(raw as SectionId) ? (raw as SectionId) : "queue";
}

/**
 * Catalog Management: one workspace for the catalog administration that used to be four
 * equal-level tabs on Products (Categories, Tags, Organize, Register matches).
 *
 * One route with three in-place sections, not three routes. That matters for more than tidiness:
 * these sections are switched between constantly while working through a backlog — file a
 * category, check what the category tree looks like, come back — and a route change per switch
 * costs a refetch and loses the queue's filters and page position each time.
 *
 * Because the sections really are rendered in place, `SegmentedTabs` uses genuine ARIA tab
 * semantics with the arrow-key behaviour that contract requires.
 */
export function ManagePageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { setLastSegmentLabel } = usePageChrome();
  const { permissionKeys } = usePermissions();
  const canViewMeta = permissionKeys.includes("product_meta.view");

  const [section, setSection] = useState<SectionId>(() =>
    parseSection(searchParams.get("section")),
  );
  const importId = searchParams.get("importId");
  const initialView = (searchParams.get("view") as WorkQueueViewId | null) ?? undefined;

  const { summary, reload } = useCatalogTaskSummary();

  useEffect(() => {
    setLastSegmentLabel("Catalog management");
    return () => setLastSegmentLabel(null);
  }, [setLastSegmentLabel]);

  /* Keep the section in the URL so a filtered queue can be linked to and reloaded. */
  const changeSection = useCallback(
    (next: SectionId) => {
      setSection(next);
      const params = new URLSearchParams(searchParams.toString());
      if (next === "queue") params.delete("section");
      else params.set("section", next);
      const qs = params.toString();
      router.replace(qs ? `/products/manage?${qs}` : "/products/manage", { scroll: false });
    },
    [router, searchParams],
  );

  const clearImportFilter = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("importId");
    const qs = params.toString();
    router.replace(qs ? `/products/manage?${qs}` : "/products/manage", { scroll: false });
  }, [router, searchParams]);

  const tabs = useMemo(
    () => [
      {
        id: "queue" as const,
        label: "Work queue",
        icon: <IconClipboardList size={14} />,
        count: summary?.open ?? null,
        attention: (summary?.open ?? 0) > 0,
        countLabel: "open tasks",
      },
      ...(canViewMeta
        ? [
            { id: "categories" as const, label: "Categories", icon: <IconGrid size={14} /> },
            { id: "tags" as const, label: "Tags", icon: <IconTag size={14} /> },
          ]
        : []),
    ],
    [canViewMeta, summary],
  );

  return (
    <div className={css.page}>
      <Link href="/products" className={css.backLink}>
        <IconChevronLeft size={14} aria-hidden />
        Products
      </Link>

      <PageHeader
        subtitleOnly
        description="Resolve catalog issues and maintain how products are organised."
      />

      <SegmentedTabs
        items={tabs}
        active={section}
        onChange={changeSection}
        ariaLabel="Catalog management sections"
      />

      <SegmentedTabPanel id="queue" active={section === "queue"}>
        <WorkQueueSection
          summary={summary}
          onSummaryChange={reload}
          importId={importId}
          onClearImportFilter={clearImportFilter}
          initialView={initialView}
        />
      </SegmentedTabPanel>

      {canViewMeta && (
        <>
          <SegmentedTabPanel id="categories" active={section === "categories"}>
            <CategoriesSection />
          </SegmentedTabPanel>

          <SegmentedTabPanel id="tags" active={section === "tags"}>
            <TagsSection />
          </SegmentedTabPanel>
        </>
      )}
    </div>
  );
}
