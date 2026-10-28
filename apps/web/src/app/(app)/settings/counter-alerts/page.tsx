"use client";

import { useEffect, useState } from "react";
import {
  COUNTER_ALERT_LABELS,
  validateCounterAlertPolicy,
  type CounterAlertPolicyView,
  type CounterAlertRule,
} from "@pharmaceylon/shared";
import { Alert } from "@/components/alert";
import { ActionButton, PageHeader, ToggleSwitch } from "@/components/ui";
import { IconBell } from "@/components/icons";
import { apiJson } from "@/lib/auth-client";
import { usePermissions } from "@/lib/permissions";
import css from "../settings.module.css";
import { fetchApprovalRoles, type ApprovalRoleOption } from "../lib/tenant-settings";

const ENDPOINT = "/tenant/settings/counter-alerts";
/** Shown if the role list can't be loaded, so the recipients still read sensibly. */
const BUILT_IN_ROLES: ApprovalRoleOption[] = [
  { key: "owner", name: "Owner", isSystem: true },
  { key: "manager", name: "Manager", isSystem: true },
  { key: "pharmacist", name: "Pharmacist", isSystem: true },
  { key: "inventory_clerk", name: "Inventory Clerk", isSystem: true },
  { key: "cashier", name: "Cashier", isSystem: true },
];

export default function CounterAlertsSettingsPage() {
  const { permissionKeys } = usePermissions();
  const canEdit = permissionKeys.includes("tenant.management");
  const [view, setView] = useState<CounterAlertPolicyView | null>(null);
  const [roles, setRoles] = useState<ApprovalRoleOption[]>(BUILT_IN_ROLES);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiJson<CounterAlertPolicyView>(ENDPOINT).then(
      (result) => {
        if (!cancelled) setView(result);
      },
      (err) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "Couldn't load counter alerts.");
      },
    );
    fetchApprovalRoles().then(
      (rows) => {
        if (!cancelled && rows.length > 0) setRoles(rows);
      },
      () => {
        // The built-in list is enough to show the setting.
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  function editRule(next: CounterAlertRule) {
    setView((current) =>
      current && {
        ...current,
        policy: {
          ...current.policy,
          rules: current.policy.rules.map((rule) => (rule.type === next.type ? next : rule)),
        },
      },
    );
    setSaved(false);
  }

  async function save() {
    if (!view) return;
    const parsed = validateCounterAlertPolicy(view.policy);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      setView(
        await apiJson<CounterAlertPolicyView>(ENDPOINT, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expectedVersion: view.version, policy: parsed.value }),
        }),
      );
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save counter alerts.");
    } finally {
      setSaving(false);
    }
  }

  // Keep a role that was chosen but has since left the role list visible, so it can be removed.
  const shown = (rule: CounterAlertRule) => [
    ...roles,
    ...rule.recipientRoleKeys
      .filter((key) => !roles.some((role) => role.key === key))
      .map((key) => ({ key, name: key, isSystem: false })),
  ];
  const disabled = !canEdit || saving;

  return (
    <div>
      <PageHeader
        title="Counter alerts"
        description="Which counter problems raise an alert, and which roles receive it. Every branch uses the same rules."
      />
      {error ? <Alert variant="error">{error}</Alert> : null}
      {view ? (
        <section className={css.card} aria-label="Counter alerts">
          <h2 className={css.cardTitle}>
            <IconBell size={16} /> Alert types and recipients
          </h2>
          <p className={css.cardDesc}>
            Staff receive an alert only at branches where they hold that role. Alerts appear in the
            notification bell; counter alerts are being added there, so some types won&apos;t
            arrive yet.
          </p>
          {view.policy.rules.map((rule) => {
            const { label, hint } = COUNTER_ALERT_LABELS[rule.type];
            return (
              <div key={rule.type} className={css.rowItem}>
                <div style={{ flex: 1 }}>
                  <div className={css.rowLabel}>{label}</div>
                  <div className={css.rowHint}>{hint}</div>
                  {rule.enabled ? (
                    <div className={css.chipRow} role="group" aria-label={`${label} recipients`}>
                      {shown(rule).map((role) => {
                        const on = rule.recipientRoleKeys.includes(role.key);
                        return (
                          <button
                            key={role.key}
                            type="button"
                            aria-pressed={on}
                            className={`${css.chip}${on ? ` ${css.chipOn}` : ""}`}
                            disabled={disabled}
                            onClick={() =>
                              editRule({
                                ...rule,
                                recipientRoleKeys: on
                                  ? rule.recipientRoleKeys.filter((key) => key !== role.key)
                                  : [...rule.recipientRoleKeys, role.key],
                              })
                            }
                          >
                            {role.name}
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
                <ToggleSwitch
                  label={`Send ${label.toLowerCase()} alerts`}
                  checked={rule.enabled}
                  disabled={disabled}
                  onChange={(enabled) => editRule({ ...rule, enabled })}
                />
              </div>
            );
          })}
          {canEdit ? (
            <div className={css.saveRow}>
              {saved ? <span role="status">Saved.</span> : null}
              <ActionButton onClick={save} disabled={saving}>
                {saving ? "Saving…" : "Save counter alerts"}
              </ActionButton>
            </div>
          ) : null}
        </section>
      ) : !error ? (
        <p className={css.rowHint}>Loading…</p>
      ) : null}
    </div>
  );
}
