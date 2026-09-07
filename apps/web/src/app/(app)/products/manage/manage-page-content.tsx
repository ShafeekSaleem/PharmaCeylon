"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  IconClipboardList,
  IconGrid,
  IconPlus,
  IconTag,
} from "@/components/icons";
import {
  ActionButton,
  PageHeader,
  SegmentedTabPanel,
  SegmentedTabs,
} from "@/components/ui";
import { usePageChrome } from "@/lib/page-chrome-context";
import { usePermissions } from "@/lib/permissions";
import { useCatalogTaskSummary } from "../hooks/use-catalog-task-summary";
import { CategoriesSection } from "./sections/categories-section";
import { TagsSection } from "./sections/tags-section";
import {
  WorkQueueSection,
  type WorkQueueViewId,
} from "./sections/work-queue-section";
import css from "./manage.module.css";

const SECTIONS = ["queue", "categories", "tags"] as const;
type SectionId = (typeof SECTIONS)[number];

/**
 * The lead sentence belongs to the section, not the workspace. One line describing all three at
 * once ("resolve catalog issues and maintain how products are organised") describes none of them
 * well enough to orient someone who has just landed on Tags.
 */
const SECTION_LEAD: Record<SectionId, string> = {
  queue: "Review and resolve catalog issues found in your products.",
  categories: "Organise how your products are grouped across the pharmacy.",
  tags: "Create labels to group products across categories.",
};

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
  const canManageMeta = permissionKeys.includes("product_meta.manage");

  const [section, setSection] = useState<SectionId>(() =>
    parseSection(searchParams.get("section")),
  );
  const importId = searchParams.get("importId");
  const initialView =
    (searchParams.get("view") as WorkQueueViewId | null) ?? undefined;

  const { summary, reload } = useCatalogTaskSummary();

  /*
   * "New category" / "New tag" belong in the page header, where every other page in the app puts
   * its primary action — but the modal, its API call and the reload after it belong to the
   * section. Rather than hoisting all of that, the header raises a request and the section
   * acknowledges it once it has opened its own modal.
   */
  const [pendingCreate, setPendingCreate] = useState<SectionId | null>(null);
  const clearPendingCreate = useCallback(() => setPendingCreate(null), []);

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
      router.replace(qs ? `/products/manage?${qs}` : "/products/manage", {
        scroll: false,
      });
    },
    [router, searchParams],
  );

  const clearImportFilter = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("importId");
    const qs = params.toString();
    router.replace(qs ? `/products/manage?${qs}` : "/products/manage", {
      scroll: false,
    });
  }, [router, searchParams]);

  /*
   * No count on the Work queue tab. It rode along on every section, so standing on Categories
   * meant reading a lone "212" capsule that belonged to a different tab and filtered nothing.
   * The number is already on the Products page's "Manage catalog" badge, which is where it is
   * acted on, and inside the queue its own "Open" filter chip states it.
   */
  const tabs = useMemo(
    () => [
      {
        id: "queue" as const,
        label: "Work queue",
        icon: <IconClipboardList size={14} />,
      },
      ...(canViewMeta
        ? [
            {
              id: "categories" as const,
              label: "Categories",
              icon: <IconGrid size={14} />,
            },
            { id: "tags" as const, label: "Tags", icon: <IconTag size={14} /> },
          ]
        : []),
    ],
    [canViewMeta],
  );

  return (
    <div className={css.page}>
      <PageHeader
        subtitleOnly
        floatingActions
        description={SECTION_LEAD[section]}
        actions={
          canManageMeta && section !== "queue" ? (
            <ActionButton
              icon={<IconPlus size={16} />}
              tooltip={
                section === "categories"
                  ? "Create a merchandising category"
                  : "Create a tag"
              }
              onClick={() => setPendingCreate(section)}
            >
              {section === "categories" ? "New category" : "New tag"}
            </ActionButton>
          ) : null
        }
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
            <CategoriesSection
              createRequested={pendingCreate === "categories"}
              onCreateHandled={clearPendingCreate}
            />
          </SegmentedTabPanel>

          <SegmentedTabPanel id="tags" active={section === "tags"}>
            <TagsSection
              createRequested={pendingCreate === "tags"}
              onCreateHandled={clearPendingCreate}
            />
          </SegmentedTabPanel>
        </>
      )}
    </div>
  );
}
