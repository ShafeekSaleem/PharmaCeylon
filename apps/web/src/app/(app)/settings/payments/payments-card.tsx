"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  effectiveDefaultPaymentMethod,
  MAX_EXTERNAL_CARD_MERCHANTS,
  ONLINE_PAYMENT_METHODS,
  ONLINE_PAYMENT_METHOD_LABELS,
} from "@pharmaceylon/shared";
import { ActionButton, FormField, ToggleSwitch } from "@/components/ui";
import { IconLock } from "@/components/icons";
import css from "../settings.module.css";
import { CounterPolicySection, SyncNote } from "../lib/counter-policy";
import { fetchTenantSettings } from "../lib/tenant-settings";

const DEFAULT_LABELS: Record<string, string> = { cash: "Cash", card: "Card", split: "Split" };

export function PaymentsCard() {
  // The default payment method is tenant-wide (Counters & receipts); card is this branch's choice.
  const [tenantDefault, setTenantDefault] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchTenantSettings().then(
      (settings) => {
        if (!cancelled) setTenantDefault(settings.posDefaultPaymentMethod);
      },
      () => {
        // Without it the note is left out; the setting itself still saves.
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <CounterPolicySection
      title="Payments"
      saveLabel="Save payments"
      description={
        <>
          <p className={css.cardDesc}>
            How customers can pay at this branch&apos;s counters. Cash is always accepted, online
            and offline.
          </p>
          <SyncNote />
        </>
      }
    >
      {({ view, disabled, edit }) => {
        const { policy } = view;
        const setMerchants = (externalCardMerchants: typeof policy.externalCardMerchants) =>
          edit({ ...policy, externalCardMerchants });
        return (
          <>
            <p className={css.subLabel}>Online counters</p>
            <div className={css.rowItem}>
              <span>Cash</span>
              <span className={css.badgeLocked}>
                <IconLock size={11} /> Always on
              </span>
            </div>
            {ONLINE_PAYMENT_METHODS.map((method) => {
              const label = `Accept ${ONLINE_PAYMENT_METHOD_LABELS[method].toLowerCase()} online`;
              return (
                <div key={method} className={css.rowItem}>
                  <span>{ONLINE_PAYMENT_METHOD_LABELS[method]}</span>
                  <ToggleSwitch
                    label={label}
                    checked={policy.onlinePaymentMethods.includes(method)}
                    disabled={disabled}
                    onChange={(on) =>
                      edit({
                        ...policy,
                        onlinePaymentMethods: on
                          ? [...policy.onlinePaymentMethods, method]
                          : policy.onlinePaymentMethods.filter((m) => m !== method),
                      })
                    }
                  />
                </div>
              );
            })}

            {tenantDefault ? (
              <DefaultMethodNote tenantDefault={tenantDefault} methods={policy.onlinePaymentMethods} />
            ) : null}

            <p className={css.subLabel}>Offline counter</p>
            <div className={css.rowItem}>
              <span>Allow approved external card payments offline</span>
              <ToggleSwitch
                label="Allow approved external card payments offline"
                checked={policy.offlineExternalCardEnabled}
                disabled={disabled || !policy.offlineEnabled}
                onChange={(enabled) => edit({ ...policy, offlineExternalCardEnabled: enabled })}
              />
            </div>
            {!policy.offlineEnabled ? (
              <p className={css.rowHint}>
                Offline selling is off for this branch. Turn it on in{" "}
                <Link href="/settings/offline-policy">Offline policy</Link> first.
              </p>
            ) : null}
            <p className={css.rowHint}>
              A card must be approved independently by its provider. The counter records its
              original approval reference; it does not authorize cards. Provider and merchant IDs
              identify where a reference must be unique. Enter identifiers only, never
              credentials.
            </p>
            {policy.externalCardMerchants.map((merchant, index) => (
              <div key={index} className={css.formGrid}>
                <FormField
                  label={`Provider ${index + 1}`}
                  value={merchant.provider}
                  maxLength={80}
                  disabled={disabled}
                  onChange={(event) =>
                    setMerchants(
                      policy.externalCardMerchants.map((row, i) =>
                        i === index ? { ...row, provider: event.target.value } : row,
                      ),
                    )
                  }
                />
                <FormField
                  label={`Merchant ID ${index + 1}`}
                  value={merchant.merchantId}
                  maxLength={120}
                  disabled={disabled}
                  onChange={(event) =>
                    setMerchants(
                      policy.externalCardMerchants.map((row, i) =>
                        i === index ? { ...row, merchantId: event.target.value } : row,
                      ),
                    )
                  }
                />
                {view.canEdit ? (
                  <ActionButton
                    disabled={disabled}
                    onClick={() =>
                      setMerchants(policy.externalCardMerchants.filter((_, i) => i !== index))
                    }
                  >
                    Remove merchant {index + 1}
                  </ActionButton>
                ) : null}
              </div>
            ))}
            {view.canEdit ? (
              <ActionButton
                disabled={
                  disabled || policy.externalCardMerchants.length >= MAX_EXTERNAL_CARD_MERCHANTS
                }
                onClick={() =>
                  setMerchants([...policy.externalCardMerchants, { provider: "", merchantId: "" }])
                }
              >
                Add card merchant
              </ActionButton>
            ) : null}
          </>
        );
      }}
    </CounterPolicySection>
  );
}

function DefaultMethodNote({
  tenantDefault,
  methods,
}: {
  tenantDefault: string;
  methods: Parameters<typeof effectiveDefaultPaymentMethod>[1];
}) {
  const effective = effectiveDefaultPaymentMethod(tenantDefault, methods);
  const chosen = DEFAULT_LABELS[tenantDefault] ?? tenantDefault;
  return (
    <p className={css.rowHint}>
      Sales start on the default payment method from{" "}
      <Link href="/settings/main">Counters &amp; receipts</Link>: {chosen}.
      {effective !== tenantDefault
        ? ` This branch doesn't take card, so its counters start on cash instead.`
        : null}
    </p>
  );
}
