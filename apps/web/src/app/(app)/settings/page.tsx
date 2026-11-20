"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/ui";
import { IconAlertTriangle, IconChevronRight, IconSearch } from "@/components/icons";
import { readAppearancePrefs } from "@/lib/appearance";
import { fetchTenantBranches } from "@/lib/auth-client";
import { useBranchRollout } from "@/lib/branch-rollout";
import { fetchNotificationPreferences } from "@/lib/notifications-client";
import { usePermissions } from "@/lib/permissions";
import {
  SETTINGS_GROUPS,
  groupSettingsItems,
  searchSettings,
  visibleSettingsItems,
} from "@/lib/settings-menu";
import { useAuth } from "@/lib/use-auth";
import { countersApi } from "./counters/counters-api";
import { counterRestoreApi } from "./offline-policy/counter-restore-api";
import { journalRecoveryApi } from "./offline-policy/journal-recovery-api";
import { fetchTenantProfile } from "./tenant-profile/api";
import { fetchTenantSettings } from "./lib/tenant-settings";
import { needsAttention, settingsValues, type SettingsOverview } from "./lib/settings-overview";
import css from "./settings-home.module.css";

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

  const overview = useSettingsOverview({
    user: user ? { id: user.id, fullName: user.fullName, email: user.email } : null,
    branchId,
    isAdmin: isAdmin && !personalOnly,
    personalOnly,
  });
  const desktopLive = !!rollout && rollout.state !== "not_live";
  const data = { ...overview.data, desktopLive };
  const values = settingsValues(data);
  const attention = needsAttention(data);

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
          {results.length === 0 ? (
            <p className={css.empty}>No setting matches “{query.trim()}”.</p>
          ) : (
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
                Needs attention
              </h2>
              {!overview.loaded ? (
                <p className={css.empty}>Checking…</p>
              ) : attention.length === 0 ? (
                <p className={css.empty}>Nothing needs your attention.</p>
              ) : (
                <ul className={css.attentionList}>
                  {attention.map((a) => (
                    <li key={a.title}>
                      <Link href={a.href} className={css.attentionRow}>
                        <span className={css.attentionIcon}>
                          <IconAlertTriangle size={16} aria-hidden />
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
                <span className={css.groupScope}>{group.scope}</span>
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
  personalOnly,
}: {
  user: { id: string; fullName: string; email: string } | null;
  branchId: string | null;
  isAdmin: boolean;
  personalOnly: boolean;
}): { data: SettingsOverview; loaded: boolean } {
  const [data, setData] = useState<SettingsOverview>({});
  const [loaded, setLoaded] = useState(false);
  const userId = user?.id;
  const fullName = user?.fullName;
  const email = user?.email;

  useEffect(() => {
    let cancelled = false;
    const base: SettingsOverview = {
      user: fullName && email ? { fullName, email } : undefined,
      appearance: readAppearancePrefs(userId),
    };
    setData(base);
    setLoaded(false);

    // Each read stands alone: one failing (or refused) leaves its card on its description.
    const quiet = <T,>(p: Promise<T>) => p.catch(() => undefined);
    const reads: Promise<Partial<SettingsOverview>>[] = [
      quiet(fetchNotificationPreferences()).then((notifications) => ({ notifications })),
    ];
    if (!personalOnly) {
      reads.push(quiet(fetchTenantSettings()).then((settings) => ({ settings })));
    }
    if (isAdmin) {
      reads.push(
        quiet(fetchTenantProfile()).then((p) =>
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
      if (branchId) {
        reads.push(
          quiet(countersApi.counters()).then((counters) =>
            counters ? { counterCount: counters.length } : {},
          ),
          quiet(counterRestoreApi(branchId).list()).then((view) =>
            view
              ? {
                  restoresWaiting: view.restores.filter(
                    (r) => r.status === "awaiting_acknowledgement",
                  ).length,
                }
              : {},
          ),
          quiet(journalRecoveryApi(branchId).list()).then((view) =>
            view
              ? {
                  recoveriesWaiting: view.recoveries.filter(
                    (r) => r.status === "awaiting_approval" && !r.stale,
                  ).length,
                }
              : {},
          ),
        );
      }
    }
    void Promise.all(reads).then((parts) => {
      if (cancelled) return;
      setData(Object.assign({}, base, ...parts));
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [userId, fullName, email, branchId, isAdmin, personalOnly]);

  return { data, loaded };
}
