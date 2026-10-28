"use client";

import Link from "next/link";
import { COUNTER_OFFLINE_RULES } from "@pharmaceylon/shared";
import { ToggleSwitch } from "@/components/ui";
import { IconLock } from "@/components/icons";
import css from "../settings.module.css";
import { CounterPolicySection, SyncNote } from "../lib/counter-policy";

/** Fixed v1 rules (approved D3/D4/D5). Shown so owners know them; no setting can change them. */
const FIXED_RULES: { label: string; hint: string }[] = [
  {
    label: `Offline permission lasts ${COUNTER_OFFLINE_RULES.permissionHours} hours`,
    hint: "Counted from the counter's last successful online renewal. It can't be renewed while offline.",
  },
  {
    label: `Stock at most ${COUNTER_OFFLINE_RULES.snapshotFreshnessMinutes} minutes old`,
    hint: "The counter's last stock update must be this recent when the outage starts, or it can't sell offline.",
  },
  {
    label: "Ordinary items only",
    hint: "No prescription or controlled items, and no discounts or price overrides.",
  },
  {
    label: "Cash, plus external card if allowed",
    hint: "Including split tender. No mobile wallets or customer credit offline.",
  },
];

export function OfflinePolicyCard() {
  return (
    <CounterPolicySection
      title="Offline selling"
      saveLabel="Save offline policy"
      description={
        <>
          <p className={css.cardDesc}>
            Whether one prepared counter at this branch may keep selling through an internet
            outage. Turning it off never stops online selling. Desktop offline trading is not
            available yet; saving this does not enable a counter.
          </p>
          <SyncNote>
            Turning it off can&apos;t instantly revoke permission already saved on a disconnected
            counter; that permission still ends at its expiry.
          </SyncNote>
        </>
      }
    >
      {({ view, disabled, edit }) => (
        <>
          <div className={css.rowItem}>
            <span>Allow offline selling for this branch</span>
            <ToggleSwitch
              label="Allow offline selling for this branch"
              checked={view.policy.offlineEnabled}
              disabled={disabled}
              onChange={(enabled) =>
                edit({
                  ...view.policy,
                  offlineEnabled: enabled,
                  offlineExternalCardEnabled: enabled && view.policy.offlineExternalCardEnabled,
                })
              }
            />
          </div>
          {view.policy.offlineEnabled ? (
            <p className={css.rowHint}>
              External card offline is set in <Link href="/settings/payments">Payments</Link>.
            </p>
          ) : null}
          <p className={css.subLabel}>Fixed rules</p>
          {FIXED_RULES.map((rule) => (
            <div key={rule.label} className={css.rowItem}>
              <div>
                <div className={css.rowLabel}>{rule.label}</div>
                <div className={css.rowHint}>{rule.hint}</div>
              </div>
              <span className={css.badgeLocked}>
                <IconLock size={11} /> Fixed
              </span>
            </div>
          ))}
        </>
      )}
    </CounterPolicySection>
  );
}
