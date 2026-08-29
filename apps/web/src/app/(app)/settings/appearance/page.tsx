"use client";

import { useEffect, useState } from "react";
import { PageHeader, StatusBadge } from "@/components/ui";
import { IconSparkles, IconSun, IconMoon, IconCloudSun } from "@/components/icons";
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
  const [prefs, setPrefs] = useState(DEFAULT_APPEARANCE_PREFS);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setPrefs(readAppearancePrefs());
    setReady(true);
  }, []);

  function update(next: Partial<typeof prefs>) {
    setPrefs((p) => {
      const merged = { ...p, ...next };
      writeAppearancePrefs(merged);
      applyAppearancePrefs(merged);
      return merged;
    });
  }

  return (
    <div>
      <PageHeader
        title="Appearance"
        description="Personal display preferences — visible only to you, saved in this browser."
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
        <div className={css.optionRow}>
          <button type="button" className={`${css.optionCard} ${css.optionCardSelected}`} disabled={!ready}>
            <span className={css.optionCardIcon}>
              <IconSun size={20} />
            </span>
            Light
          </button>
          <button type="button" className={css.optionCard} disabled>
            <span className={css.optionSoonBadge}>
              <StatusBadge status="soon" label="Soon" variant="muted" />
            </span>
            <span className={css.optionCardIcon}>
              <IconMoon size={20} />
            </span>
            Dark
          </button>
          <button type="button" className={css.optionCard} disabled>
            <span className={css.optionCardIcon}>
              <IconCloudSun size={20} />
            </span>
            System
          </button>
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
              style={{ background: s.color }}
              onClick={() => update({ accent: s.value })}
              disabled={!ready}
            />
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
      </div>
    </div>
  );
}
