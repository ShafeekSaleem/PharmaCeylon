"use client";

import { useEffect, useState } from "react";
import { ActionButton, PageHeader } from "@/components/ui";
import { IconMoon, IconSparkles, IconSun } from "@/components/icons";
import { useAuth } from "@/lib/use-auth";
import {
  APPEARANCE_CHANGED_EVENT,
  readAppearancePrefs,
  saveAppearancePrefs,
  DEFAULT_APPEARANCE_PREFS,
  type AppearancePrefs,
  type Density,
  type FontSize,
  type Theme,
} from "@/lib/appearance";
import css from "../settings.module.css";
import { PharmacyBrandCard } from "./pharmacy-brand-card";

const THEME_CHOICES: { value: Theme; label: string; icon: React.ReactNode }[] = [
  { value: "system", label: "Match device", icon: <IconSparkles size={14} /> },
  { value: "light", label: "Light", icon: <IconSun size={14} /> },
  { value: "dark", label: "Dark", icon: <IconMoon size={14} /> },
];

export default function AppearancePage() {
  const { user } = useAuth();
  const [prefs, setPrefs] = useState(DEFAULT_APPEARANCE_PREFS);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setPrefs(readAppearancePrefs(user?.id));
    setReady(true);
    // The top-bar switch changes the theme from outside this page.
    const onChange = (e: Event) => setPrefs((e as CustomEvent<AppearancePrefs>).detail);
    window.addEventListener(APPEARANCE_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(APPEARANCE_CHANGED_EVENT, onChange);
  }, [user?.id]);

  function update(next: Partial<typeof prefs>) {
    saveAppearancePrefs({ ...prefs, ...next }, user?.id);
  }

  function reset() {
    saveAppearancePrefs(DEFAULT_APPEARANCE_PREFS, user?.id);
  }

  return (
    <div>
      <PageHeader
        title="Appearance"
        description="Your own display preferences on this device, and the pharmacy's brand colours."
        actions={<ActionButton variant="secondary" onClick={reset} disabled={!ready}>Reset defaults</ActionButton>}
      />

      <div className={css.card}>
        <div className={css.cardHead}>
          <div>
            <h2 className={css.cardTitle}>
              <IconSparkles size={16} /> Display
            </h2>
          </div>
        </div>

        <p className={css.subLabel}>Theme</p>
        <div className={css.pillRow}>
          {THEME_CHOICES.map((choice) => (
            <button
              key={choice.value}
              type="button"
              aria-pressed={prefs.theme === choice.value}
              className={`${css.pill}${prefs.theme === choice.value ? ` ${css.pillSelected}` : ""}`}
              onClick={() => update({ theme: choice.value })}
              disabled={!ready}
            >
              {choice.icon}
              {choice.label}
            </button>
          ))}
        </div>
        <p className={css.rowHint}>
          Match device follows your computer's setting and changes with it. The sun/moon button in the top bar switches straight to the other one.
        </p>


        <p className={css.subLabel}>Density</p>
        <div className={css.pillRow}>
          {(["comfortable", "compact"] as Density[]).map((d) => (
            <button
              key={d}
              type="button"
              className={`${css.pill}${prefs.density === d ? ` ${css.pillSelected}` : ""}`}
              onClick={() => update({ density: d })}
              disabled={!ready}
            >
              {d === "comfortable" ? "Comfortable" : "Compact"}
            </button>
          ))}
        </div>

        <p className={css.subLabel}>Font size</p>
        <div className={css.pillRow}>
          {(["small", "medium", "large"] as FontSize[]).map((f) => (
            <button
              key={f}
              type="button"
              className={`${css.pill}${prefs.fontSize === f ? ` ${css.pillSelected}` : ""}`}
              onClick={() => update({ fontSize: f })}
              disabled={!ready}
            >
              {f[0].toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>

        <div className={css.appearancePreview}>
          <div>
            <div className={css.avatarTitle}>Preview</div>
            <div className={css.rowHint}>Changes apply immediately across forms, tables and navigation.</div>
          </div>
          <button type="button" className={css.previewPrimary}>Primary action</button>
          <span className={`${css.chip} ${css.chipOn}`}>Active</span>
        </div>
      </div>

      <PharmacyBrandCard user={user} />
    </div>
  );
}
