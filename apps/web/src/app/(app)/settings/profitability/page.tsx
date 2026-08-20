"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import { PageHeader, ActionButton } from "@/components/ui";
import { usePermissions } from "@/lib/permissions";
import { fetchProfitabilityTargetSetting, saveProfitabilityTargetSetting } from "./api";

export default function ProfitabilitySettingsPage() {
  const { permissionKeys } = usePermissions();
  const canEdit = permissionKeys.includes("tenant.management");

  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchProfitabilityTargetSetting()
      .then((res) => {
        if (cancelled) return;
        setInput(res.targetGrossMarginPercent != null ? String(res.targetGrossMarginPercent) : "");
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load the current target");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSave() {
    setError(null);
    setSaved(false);
    const trimmed = input.trim();
    const value = trimmed === "" ? null : Number(trimmed);
    if (value != null && (Number.isNaN(value) || value < 0 || value > 100)) {
      setError("Enter a margin between 0 and 100, or leave the field blank to clear the target.");
      return;
    }
    setSaving(true);
    try {
      await saveProfitabilityTargetSetting(value);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save the target");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Profitability"
        description="The tenant-wide gross margin % goal shown on Reports → Profitability → Gross Profit's goal tracker."
      />
      {error ? <Alert variant="error">{error}</Alert> : null}
      {saved ? <Alert variant="success">Target saved.</Alert> : null}

      <div
        style={{
          background: "var(--pc-card-bg)",
          border: "1px solid var(--pc-border)",
          borderRadius: "var(--pc-radius-md)",
          padding: "1.25rem",
          maxWidth: 420,
          marginTop: "0.75rem",
        }}
      >
        <label htmlFor="target-margin" style={{ display: "block", fontSize: "0.82rem", fontWeight: 600, marginBottom: "0.4rem" }}>
          Target gross margin %
        </label>
        <input
          id="target-margin"
          type="number"
          min={0}
          max={100}
          step={0.1}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={!canEdit || loading}
          placeholder="Not set"
          style={{
            width: "100%",
            padding: "0.5rem 0.65rem",
            border: "1px solid var(--pc-border)",
            borderRadius: "var(--pc-radius-sm)",
            fontSize: "0.9rem",
            background: "var(--pc-card-bg)",
            color: "var(--pc-foreground)",
          }}
        />
        <p style={{ fontSize: "0.78rem", color: "var(--pc-muted-fg)", margin: "0.5rem 0 0" }}>
          Leave blank to remove the goal — the Gross Profit page shows an unset state instead of a
          fabricated target when nothing is configured.
        </p>
        {canEdit ? (
          <div style={{ marginTop: "0.9rem" }}>
            <ActionButton onClick={handleSave} disabled={saving || loading}>
              {saving ? "Saving…" : "Save"}
            </ActionButton>
          </div>
        ) : (
          <p style={{ fontSize: "0.78rem", color: "var(--pc-muted-fg)", marginTop: "0.75rem" }}>
            Only owners and managers can change this setting.
          </p>
        )}
      </div>
    </div>
  );
}
