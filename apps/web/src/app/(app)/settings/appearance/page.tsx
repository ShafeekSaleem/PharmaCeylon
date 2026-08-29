"use client";

import { useEffect, useState } from "react";
import { ActionButton, PageHeader } from "@/components/ui";
import { IconCheck, IconSparkles } from "@/components/icons";
import { useAuth } from "@/lib/use-auth";
import {
  applyAppearancePrefs,
  readAppearancePrefs,
  writeAppearancePrefs,
  DEFAULT_APPEARANCE_PREFS,
  type AccentColor,
  type Density,
  type FontSize,
} from "@/lib/appearance";
import css from "../settings.module.css";

const ACCENT_SWATCHES: { value: AccentColor; color: string }[] = [
  { value: "teal", color: "#0d9488" },
  { value: "cyan", color: "#0891b2" },
  { value: "navy", color: "#1e40af" },
];

export default function AppearancePage() {
  const { user } = useAuth();
  const [prefs, setPrefs] = useState(DEFAULT_APPEARANCE_PREFS);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setPrefs(readAppearancePrefs(user?.id));
    setReady(true);
  }, [user?.id]);

  function update(next: Partial<typeof prefs>) {
    setPrefs((p) => {
      const merged = { ...p, ...next };
      writeAppearancePrefs(merged, user?.id);
      applyAppearancePrefs(merged);
      return merged;
    });
  }

  function reset() {
    setPrefs(DEFAULT_APPEARANCE_PREFS);
    writeAppearancePrefs(DEFAULT_APPEARANCE_PREFS, user?.id);
    applyAppearancePrefs(DEFAULT_APPEARANCE_PREFS);
  }

  return (
    <div>
      <PageHeader
        title="Appearance"
        description="Personal display preferences for your account on this device."
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

        <p className={css.subLabel}>Accent color</p>
        <div className={css.swatchRow}>
          {ACCENT_SWATCHES.map((s) => (
            <button
              key={s.value}
              type="button"
              aria-label={`${s.value} accent`}
              aria-pressed={prefs.accent === s.value}
              className={`${css.swatch}${prefs.accent === s.value ? ` ${css.swatchSelected}` : ""}`}
              style={{ background: s.color, "--swatch-ring": s.color } as React.CSSProperties}
              onClick={() => update({ accent: s.value })}
              disabled={!ready}
            >
              {prefs.accent === s.value ? <IconCheck size={15} /> : null}
            </button>
          ))}
        </div>

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
    </div>
  );
}
