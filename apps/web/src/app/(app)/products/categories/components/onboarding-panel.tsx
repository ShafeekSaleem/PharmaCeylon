"use client";

import { useState } from "react";
import { ModalButton } from "@/components/ui";
import type { OnboardingGroupStatus } from "../types";
import css from "../categories.module.css";

type Props = {
  groups: OnboardingGroupStatus[];
  saving: boolean;
  onSave: (selectedLabels: string[]) => void;
  onDismiss: () => void;
};

/** First-run "what does your pharmacy sell?" panel — shown until the tenant has enabled at least one department beyond Medicines. */
export function OnboardingPanel({ groups, saving, onSave, onDismiss }: Props) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(groups.filter((g) => g.enabled).map((g) => g.label)),
  );

  function toggle(label: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }

  return (
    <div className={css.onboardingCard}>
      <h3 className={css.onboardingTitle}>What does your pharmacy sell?</h3>
      <p className={css.onboardingSubtitle}>
        Enable the departments you stock — inactive ones stay available to turn on later. Medicines
        is on by default for every pharmacy.
      </p>
      <div className={css.onboardingGrid}>
        {groups.map((group) => (
          <label key={group.label} className={css.onboardingToggle}>
            <input
              type="checkbox"
              checked={selected.has(group.label)}
              onChange={() => toggle(group.label)}
              disabled={group.label === "Medicines"}
            />
            {group.label}
          </label>
        ))}
      </div>
      <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.9rem" }}>
        <ModalButton variant="primary" loading={saving} onClick={() => onSave([...selected])}>
          Save selection
        </ModalButton>
        <ModalButton variant="secondary" onClick={onDismiss} disabled={saving}>
          Skip for now
        </ModalButton>
      </div>
    </div>
  );
}
