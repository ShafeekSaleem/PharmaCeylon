"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { BranchHoursView, HolidaySuggestionsView } from "@pharmaceylon/shared";
import { Alert } from "@/components/alert";
import { IconChevronLeft } from "@/components/icons";
import { PageHeader } from "@/components/ui";
import { usePageChrome } from "@/lib/page-chrome-context";
import { usePermissions } from "@/lib/permissions";
import { useAuth } from "@/lib/use-auth";
import settingsCss from "../../settings.module.css";
import { BranchHoursEditor } from "../components/branch-hours-editor";
import css from "../components/branch-hours.module.css";
import { HoursExtensionsCard } from "../components/hours-extensions-card";
import { fetchBranchHours, fetchHolidaySuggestions } from "../hours-api";

/** Settings → Branches → Opening hours, for one branch (`?branch=<id>`). */
export default function BranchHoursPage() {
  return (
    <Suspense fallback={<p className={settingsCss.rowHint}>Loading…</p>}>
      <BranchHoursContent />
    </Suspense>
  );
}

function BranchHoursContent() {
  const branchId = useSearchParams().get("branch");
  const { permissionKeys } = usePermissions();
  const { user } = useAuth();
  const { setLastSegmentLabel } = usePageChrome();
  const [view, setView] = useState<BranchHoursView | null>(null);
  const [holidays, setHolidays] = useState<HolidaySuggestionsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Same rule as the Branches list and the API: the owner edits any branch, a manager only
  // their own, and only the owner changes mandatory limits.
  const isOwner = user?.branchRoles.some((br) => br.role === "owner") ?? false;
  const canEdit =
    isOwner ||
    (permissionKeys.includes("tenant.branches_manage") &&
      (user?.branchRoles.some((br) => br.branchId === branchId && br.role === "manager") ?? false));

  const load = useCallback(async () => {
    if (!branchId) return;
    try {
      setView(await fetchBranchHours(branchId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load the hours.");
    }
    // Suggestions are optional: the editor works without them.
    fetchHolidaySuggestions(branchId).then(setHolidays, () => setHolidays(null));
  }, [branchId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setLastSegmentLabel(view ? `Opening hours — ${view.branchName}` : null);
    return () => setLastSegmentLabel(null);
  }, [view, setLastSegmentLabel]);

  return (
    <div>
      <Link href="/settings/branches" className={css.backLink}>
        <IconChevronLeft size={14} /> Branches
      </Link>
      <PageHeader
        title={view ? `Opening hours — ${view.branchName}` : "Opening hours"}
        description="Routine hours, dates with different hours, mandatory limits and extended hours. Counters sign these into the permission they sell under offline."
      />
      {!branchId ? <Alert variant="error">Choose a branch from the Branches list.</Alert> : null}
      {error ? <Alert variant="error">{error}</Alert> : null}
      {view ? (
        <div className={css.stack}>
          <BranchHoursEditor
            view={view}
            canEdit={canEdit}
            canEditMandatory={isOwner}
            holidays={holidays}
            onSaved={setView}
          />
          <HoursExtensionsCard view={view} canEdit={canEdit} onChanged={setView} />
        </div>
      ) : !error && branchId ? (
        <p className={settingsCss.rowHint}>Loading…</p>
      ) : null}
    </div>
  );
}
