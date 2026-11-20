"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/ui";
import { IconAlertTriangle, IconChevronRight, IconInfo, IconSearch } from "@/components/icons";
import { readAppearancePrefs } from "@/lib/appearance";
import { fetchTenantBranches } from "@/lib/auth-client";
import { useBranchRollout } from "@/lib/branch-rollout";
import { fetchNotificationPreferences } from "@/lib/notifications-client";
import { usePermissions } from "@/lib/permissions";
import {
  SETTINGS_GROUPS,
  groupSettingsItems,
  searchSettings,
  settingsGroupScope,
  visibleSettingsItems,
} from "@/lib/settings-menu";
import { useAuth } from "@/lib/use-auth";
import { countersApi } from "./counters/counters-api";
import { notificationKeysFor } from "./notifications/preference-rows";
import { counterRestoreApi } from "./offline-policy/counter-restore-api";
import { journalRecoveryApi } from "./offline-policy/journal-recovery-api";
import { fetchTenantProfile } from "./tenant-profile/api";
import { fetchTenantSettings } from "./lib/tenant-settings";
import {
  needsAttention,
  settingsValues,
  type AttentionCheck,
  type SettingsOverview,
} from "./lib/settings-overview";
import css from "./settings-home.module.css";

/** Reading restored counters and journal recoveries needs this, as the API's
 *  OFFLINE_ASSIGNMENT_MANAGER_PERMISSION does. */
const OFFLINE_MANAGER_PERMISSION = "tenant.management";

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Settings home (UI1 #205): search, what needs attention, and every settings page as a card
 * showing its current value, grouped the same way as the settings menu.
 */
export default function SettingsHomePage() {
  const router = useRouter();
  const { user, branchId } = useAuth();
  const { permissionKeys, backOfficeAccess, accessResolved } = usePermissions();
  const { rollout } = useBranchRollout();
  const personalOnly =
    !accessResolved || !rollout || (rollout.state !== "not_live" && !backOfficeAccess);
  const isAdmin = permissionKeys.includes("tenant.management");

  const items = useMemo(
    () => visibleSettingsItems({ isAdmin, personalOnly }),
    [isAdmin, personalOnly],
  );
  const [query, setQuery] = useState("");
  const results = useMemo(() => searchSettings(items, query), [items, query]);
  const searching = query.trim().length > 0;

  const desktopLive = !!rollout && rollout.state !== "not_live";
  const notificationKeys = useMemo(() => notificationKeysFor(permissionKeys), [permissionKeys]);
  const overview = useSettingsOverview({
    user: user ? { id: user.id, fullName: user.fullName, email: user.email } : null,
    branchId,
    isAdmin: isAdmin && !personalOnly,
    canCheckOffline:
      isAdmin && !personalOnly && permissionKeys.includes(OFFLINE_MANAGER_PERMISSION),
    desktopLive,
    personalOnly,
  });
  const data = { ...overview.data, desktopLive, notificationKeys };
  const values = settingsValues(data);
  const attention = needsAttention(data);
  // The branch checks look at the selected branch only, and Settings hides the branch switch,
  // so the section says which branch it looked at.
  const attentionWhere = data.branchName ? ` at ${data.branchName}` : "";

  return (
    <div>
      <PageHeader
        title="Settings"
        description="Your own account first, then what applies to everyone at the pharmacy."
      />

      <div className={css.search}>
        <IconSearch size={16} aria-hidden />
        <input
          type="search"
          className={css.searchInput}
          aria-label="Search settings"
          placeholder="Search settings, e.g. refund limit"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && results[0]) router.push(results[0].item.href);
            if (e.key === "Escape") setQuery("");
          }}
        />
      </div>

      {searching ? (
        <section aria-label="Search results" className={css.results}>
          {/* Announced as the query changes, and says what Enter will open. */}
          <p className={css.resultCount} role="status" aria-live="polite">
            {results.length === 0
              ? `No setting matches “${query.trim()}”.`
              : `${plural(results.length, "setting")} found. Enter opens ${results[0].item.label}.`}
          </p>
          {results.length > 0 && (
            <ul className={css.resultList}>
              {results.map(({ item, field }) => {
                const group = SETTINGS_GROUPS.find((g) => g.key === item.group);
                return (
                  <li key={item.href}>
                    <Link href={item.href} className={css.result}>
                      <span className={css.cardIcon}>{item.icon(18)}</span>
                      <span className={css.cardText}>
                        <span className={css.cardTitle}>{item.label}</span>
                        <span className={css.cardValue}>
                          {field ? `Includes “${field}”` : item.description}
                          {group ? ` · ${group.label}` : ""}
                        </span>
                      </span>
                      <IconChevronRight size={16} aria-hidden />
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : (
        <>
          {isAdmin && !personalOnly && (
            <section className={css.attention} aria-labelledby="settings-attention">
              <h2 id="settings-attention" className={css.attentionTitle}>
                Needs attention{attentionWhere}
              </h2>
              {!overview.loaded ? (
                <p className={css.empty} role="status">
                  Checking…
                </p>
              ) : attention.length === 0 ? (
                <p className={css.empty}>Nothing needs your attention{attentionWhere}.</p>
              ) : (
                <ul className={css.attentionList}>
                  {attention.map((a) => (
                    <li key={a.title}>
                      <Link href={a.href} className={css.attentionRow}>
                        <span className={a.unchecked ? css.attentionIconQuiet : css.attentionIcon}>
                          {a.unchecked ? (
                            <IconInfo size={16} aria-hidden />
                          ) : (
                            <IconAlertTriangle size={16} aria-hidden />
                          )}
                        </span>
                        <span className={css.cardText}>
                          <span className={css.cardTitle}>{a.title}</span>
                          <span className={css.cardValue}>{a.detail}</span>
                        </span>
                        <IconChevronRight size={16} aria-hidden />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {groupSettingsItems(items).map(({ group, items: groupItems }) => (
            <section
              key={group.key}
              className={css.group}
              aria-labelledby={`settings-group-${group.key}`}
            >
              <div className={css.groupHead}>
                <h2 id={`settings-group-${group.key}`} className={css.groupTitle}>
                  {group.label}
                </h2>
                <span className={css.groupScope}>{settingsGroupScope(group)}</span>
              </div>
              <ul className={css.cards}>
                {groupItems.map((item) => (
                  <li key={item.href}>
                    <Link href={item.href} className={css.card}>
                      <span className={css.cardIcon}>{item.icon(18)}</span>
                      <span className={css.cardText}>
                        <span className={css.cardTitle}>{item.label}</span>
                        <span className={css.cardValue}>
                          {values[item.href] ?? item.description}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </>
      )}
    </div>
  );
}

function useSettingsOverview({
  user,
  branchId,
  isAdmin,
  canCheckOffline,
  desktopLive,
  personalOnly,
}: {
  user: { id: string; fullName: string; email: string } | null;
  branchId: string | null;
  isAdmin: boolean;
  /** May read restored counters and journal recoveries. */
  canCheckOffline: boolean;
  desktopLive: boolean;
  personalOnly: boolean;
}): { data: SettingsOverview; loaded: boolean } {
  const [data, setData] = useState<SettingsOverview>({});
  const [loaded, setLoaded] = useState(false);
  const userId = user?.id;
  const fullName = user?.fullName;
  const email = user?.email;

  useEffect(() => {
    let cancelled = false;
    // Only the checks this person may run are made, and only those can be claimed as clear.
    const checks: AttentionCheck[] = [];
    if (isAdmin) checks.push("logo");
    if (isAdmin && desktopLive) checks.push("counters");
    if (canCheckOffline) checks.push("restores", "recoveries");
    const unchecked = new Set<AttentionCheck>();
    const base: SettingsOverview = {
      user: fullName && email ? { fullName, email } : undefined,
      appearance: readAppearancePrefs(userId),
      checks,
    };
    setData(base);
    setLoaded(false);

    // Each read stands alone: one failing (or refused) leaves its card on its description, and
    // marks the check it feeds as not run, so "Needs attention" never claims it is clear.
    const quiet = <T,>(p: Promise<T>, check?: AttentionCheck) =>
      p.catch(() => {
        if (check) unchecked.add(check);
        return undefined;
      });
    const reads: Promise<Partial<SettingsOverview>>[] = [
      quiet(fetchNotificationPreferences()).then((notifications) => ({ notifications })),
    ];
    if (!personalOnly) {
      reads.push(quiet(fetchTenantSettings()).then((settings) => ({ settings })));
    }
    if (isAdmin) {
      reads.push(
        quiet(fetchTenantProfile(), "logo").then((p) =>
          p ? { organization: { displayName: p.displayName, hasLogo: !!p.logoUrl } } : {},
        ),
        quiet(fetchTenantBranches()).then((branches) =>
          branches
            ? {
                branchCount: branches.length,
                branchName: branches.find((b) => b.id === branchId)?.name,
              }
            : {},
        ),
      );
    }
    if (isAdmin && branchId) {
      reads.push(
        quiet(countersApi.counters(), desktopLive ? "counters" : undefined).then((counters) =>
          counters ? { counterCount: counters.length } : {},
        ),
      );
    }
    if (canCheckOffline && branchId) {
      reads.push(
        quiet(counterRestoreApi(branchId).list(), "restores").then((view) =>
          view
            ? {
                restoresWaiting: view.restores.filter(
                  (r) => r.status === "awaiting_acknowledgement",
                ).length,
              }
            : {},
        ),
        quiet(journalRecoveryApi(branchId).list(), "recoveries").then((view) => {
          if (!view) return {};
          const awaiting = view.recoveries.filter((r) => r.status === "awaiting_approval");
          return {
            recoveriesWaiting: awaiting.filter((r) => !r.stale).length,
            recoveriesStale: awaiting.filter((r) => r.stale).length,
          };
        }),
      );
    }
    // Without a branch the branch checks cannot run at all.
    const noBranch = !branchId && checks.some((c) => c !== "logo");
    if (noBranch) for (const c of checks) if (c !== "logo") unchecked.add(c);

    void Promise.all(reads).then((parts) => {
      if (cancelled) return;
      setData(Object.assign({}, base, ...parts, { unchecked: [...unchecked], noBranch }));
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [userId, fullName, email, branchId, isAdmin, canCheckOffline, desktopLive, personalOnly]);

  return { data, loaded };
}
