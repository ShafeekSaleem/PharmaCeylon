"use client";

import { useEffect, useState } from "react";
import {
  COUNTER_OFFLINE_RULES,
  validateCounterPolicy,
  type CounterPolicyView,
} from "@pharmaceylon/shared";
import { Alert } from "@/components/alert";
import { ActionButton, FormField, ToggleSwitch } from "@/components/ui";
import { apiJson } from "@/lib/auth-client";
import { useAuth } from "@/lib/use-auth";
import css from "../settings.module.css";

export function CounterPolicyCard() {
  const { branchId } = useAuth();
  // The key discards an unsaved draft on branch switches. The editor also cancels old reads
  // so a slow response cannot install branch A's policy in branch B's form.
  return branchId ? (
    <BranchPolicyEditor key={branchId} branchId={branchId} />
  ) : (
    <p>Choose a branch to manage its offline policy.</p>
  );
}

function BranchPolicyEditor({ branchId }: { branchId: string }) {
  const [view, setView] = useState<CounterPolicyView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const endpoint = `/tenant/branches/${branchId}/counter-policy`;

  useEffect(() => {
    let cancelled = false;
    apiJson<CounterPolicyView>(endpoint).then(
      (result) => {
        if (!cancelled) setView(result);
      },
      (err) => {
        if (!cancelled)
          setError(
            err instanceof Error
              ? err.message
              : "Couldn't load counter policy.",
          );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [endpoint]);

  function edit(policy: CounterPolicyView["policy"]) {
    setView((current) => current && { ...current, policy });
    setSaved(false);
  }

  async function save() {
    if (!view) return;
    const parsed = validateCounterPolicy(view.policy);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const result = await apiJson<CounterPolicyView>(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedVersion: view.version,
          policy: parsed.value,
        }),
      });
      setView(result);
      setSaved(true);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Couldn't save counter policy.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={css.card} aria-label="Offline counter policy">
      <h2 className={css.cardTitle}>
        Offline policy{view ? ` — ${view.branchName}` : ""}
      </h2>
      <p className={css.cardDesc}>
        Prepare the policy for this branch. Desktop offline trading is not
        available yet; saving these preferences does not enable a counter.
      </p>
      <p className={css.rowHint}>
        Applies to counters after their next sync once desktop offline trading
        is available. Disabling a setting cannot instantly revoke permission
        already saved on a disconnected counter.
      </p>
      <p className={css.rowHint}>
        Fixed rules: permission expires {COUNTER_OFFLINE_RULES.permissionHours}{" "}
        hours after its last online renewal. Stock must be at most{" "}
        {COUNTER_OFFLINE_RULES.snapshotFreshnessMinutes} minutes old when the
        original outage starts. Ordinary non-prescription, non-controlled items
        only; no discounts or price overrides. Cash and separately approved
        external card only, including split tender; no wallets or customer
        credit.
      </p>
      {error ? <Alert variant="error">{error}</Alert> : null}
      {saved ? <p role="status">Counter policy saved.</p> : null}
      {view ? (
        <>
          <div className={css.rowItem}>
            <span>Allow offline selling for this branch</span>
            <ToggleSwitch
              label="Allow offline selling for this branch"
              checked={view.policy.offlineEnabled}
              disabled={!view.canEdit || saving}
              onChange={(enabled) =>
                edit({
                  ...view.policy,
                  offlineEnabled: enabled,
                  offlineExternalCardEnabled:
                    enabled && view.policy.offlineExternalCardEnabled,
                })
              }
            />
          </div>
          <div className={css.rowItem}>
            <span>Allow approved external card payments offline</span>
            <ToggleSwitch
              label="Allow approved external card payments offline"
              checked={view.policy.offlineExternalCardEnabled}
              disabled={!view.canEdit || saving || !view.policy.offlineEnabled}
              onChange={(enabled) =>
                edit({ ...view.policy, offlineExternalCardEnabled: enabled })
              }
            />
          </div>
          <p className={css.rowHint}>
            A card must be approved independently by its provider. The counter
            records its original approval reference; it does not authorize
            cards. Provider and merchant IDs identify where a reference must be
            unique. Enter identifiers only, never credentials.
          </p>
          {view.policy.externalCardMerchants.map((merchant, index) => (
            <div key={index} className={css.formGrid}>
              <FormField
                label={`Provider ${index + 1}`}
                value={merchant.provider}
                maxLength={80}
                disabled={!view.canEdit || saving}
                onChange={(event) =>
                  edit({
                    ...view.policy,
                    externalCardMerchants:
                      view.policy.externalCardMerchants.map((row, i) =>
                        i === index
                          ? { ...row, provider: event.target.value }
                          : row,
                      ),
                  })
                }
              />
              <FormField
                label={`Merchant ID ${index + 1}`}
                value={merchant.merchantId}
                maxLength={120}
                disabled={!view.canEdit || saving}
                onChange={(event) =>
                  edit({
                    ...view.policy,
                    externalCardMerchants:
                      view.policy.externalCardMerchants.map((row, i) =>
                        i === index
                          ? { ...row, merchantId: event.target.value }
                          : row,
                      ),
                  })
                }
              />
              {view.canEdit ? (
                <ActionButton
                  disabled={saving}
                  onClick={() =>
                    edit({
                      ...view.policy,
                      externalCardMerchants:
                        view.policy.externalCardMerchants.filter(
                          (_, i) => i !== index,
                        ),
                    })
                  }
                >
                  Remove merchant {index + 1}
                </ActionButton>
              ) : null}
            </div>
          ))}
          {view.canEdit ? (
            <div className={css.saveRow}>
              <ActionButton
                disabled={
                  saving || view.policy.externalCardMerchants.length >= 20
                }
                onClick={() =>
                  edit({
                    ...view.policy,
                    externalCardMerchants: [
                      ...view.policy.externalCardMerchants,
                      { provider: "", merchantId: "" },
                    ],
                  })
                }
              >
                Add card merchant
              </ActionButton>
              <ActionButton onClick={save} disabled={saving}>
                {saving ? "Saving…" : "Save offline policy"}
              </ActionButton>
            </div>
          ) : null}
        </>
      ) : !error ? (
        <p>Loading counter policy…</p>
      ) : null}
    </section>
  );
}
