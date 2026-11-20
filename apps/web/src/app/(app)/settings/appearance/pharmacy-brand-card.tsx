"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import {
  ACCENT_PRESETS,
  DEFAULT_PHARMACY_APPEARANCE,
  accentProblem,
  normalizeHex,
  type CounterThemeDefault,
  type PharmacyAppearance,
  type PharmacyAppearanceSettings,
  type SidebarStyle,
  type ChartPalette,
  type StatusColourSet,
} from "@pharmaceylon/shared";
import { FormField, ToggleSwitch } from "@/components/ui";
import { IconCheck, IconLock, IconShield } from "@/components/icons";
import { ApiError } from "@/lib/api-error";
import type { AuthUser } from "@/lib/auth-types";
import {
  BRAND_CHANGED_EVENT,
  adoptPharmacyBrand,
  applyPharmacyBrand,
  fetchPharmacyBrand,
  savePharmacyBrand,
  settingsOf,
} from "@/lib/pharmacy-brand";
import css from "../settings.module.css";

const SIDEBAR_CHOICES: { value: SidebarStyle; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "tinted", label: "Tinted" },
  { value: "dark", label: "Dark" },
];

const CHART_CHOICES: { value: ChartPalette; label: string; set: string }[] = [
  { value: "accent", label: "Brand colours", set: "accent" },
  { value: "distinct", label: "Distinct colours", set: "distinct" },
];

const STATUS_CHOICES: { value: StatusColourSet; label: string }[] = [
  { value: "standard", label: "Standard" },
  { value: "colour-blind", label: "Colour-blind safe" },
];

const COUNTER_THEME_CHOICES: { value: CounterThemeDefault; label: string }[] = [
  { value: "system", label: "Match Windows" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export function isOwner(
  user: Pick<AuthUser, "branchRoles"> | null | undefined,
): boolean {
  return (user?.branchRoles ?? []).some((br) => br.role === "owner");
}

function same(
  a: PharmacyAppearanceSettings,
  b: PharmacyAppearanceSettings,
): boolean {
  return JSON.stringify(settingsOf(a)) === JSON.stringify(settingsOf(b));
}

/** What the Appearance page's one Save and Reset do to the brand. */
export type PharmacyBrandHandle = {
  /** Saves the owner's changes. Resolves false when the save was refused (the card says why). */
  save: () => Promise<boolean>;
  /** Puts the PharmaCeylon defaults in the form, unsaved, for the owner to save or undo. */
  resetToDefaults: () => void;
};

export type PharmacyBrandState = {
  /** The owner has changes that aren't saved yet. */
  dirty: boolean;
  /** A custom colour is typed that can't be saved. */
  invalid: boolean;
};

type Props = {
  user: AuthUser | null;
  onStateChange?: (state: PharmacyBrandState) => void;
};

/**
 * The pharmacy brand (UI1 #205): one accent, sidebar style and status colour set for everyone at
 * the pharmacy. Owners edit it here with a live preview that is put back if they leave unsaved;
 * everyone else sees what was chosen. The API refuses the same accents this form does. Saving is
 * the Appearance page's: it calls `save` through the ref, beside the person's own display.
 */
export const PharmacyBrandCard = forwardRef<PharmacyBrandHandle, Props>(function PharmacyBrandCard(
  { user, onStateChange },
  ref,
) {
  const canEdit = isOwner(user);
  const [saved, setSaved] = useState<PharmacyAppearance | null>(null);
  const [draft, setDraft] = useState<PharmacyAppearanceSettings | null>(null);
  const [hexInput, setHexInput] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{
    kind: "ok" | "error";
    text: string;
  } | null>(null);
  const savedRef = useRef<PharmacyAppearance | null>(null);
  savedRef.current = saved;

  function take(brand: PharmacyAppearance) {
    setSaved(brand);
    setDraft(settingsOf(brand));
    setHexInput(brand.accent);
  }

  useEffect(() => {
    let alive = true;
    fetchPharmacyBrand()
      .then((brand) => alive && take(brand))
      .catch(
        (e: unknown) =>
          alive &&
          setLoadError(
            e instanceof Error ? e.message : "Could not load the brand.",
          ),
      );
    const onChange = (e: Event) =>
      take((e as CustomEvent<PharmacyAppearance>).detail);
    window.addEventListener(BRAND_CHANGED_EVENT, onChange);
    return () => {
      alive = false;
      window.removeEventListener(BRAND_CHANGED_EVENT, onChange);
      // Leaving with an unsaved preview puts the pharmacy's brand back.
      if (savedRef.current) applyPharmacyBrand(settingsOf(savedRef.current));
    };
  }, []);

  const hexProblem = hexInput.trim() === "" ? null : accentProblem(hexInput);
  const dirty = canEdit && saved !== null && draft !== null && !same(saved, draft);
  const invalid = canEdit && hexProblem !== null;

  useEffect(() => {
    onStateChange?.({ dirty, invalid });
  }, [dirty, invalid, onStateChange]);

  // Live preview of whatever the owner has chosen so far.
  useEffect(() => {
    if (draft && canEdit) applyPharmacyBrand(draft);
  }, [draft, canEdit]);

  function change(next: Partial<PharmacyAppearanceSettings>) {
    if (!draft) return;
    setMessage(null);
    setDraft({ ...draft, ...next });
  }

  function pickAccent(hex: string) {
    setHexInput(hex);
    change({ accent: hex });
  }

  function typeAccent(value: string) {
    setHexInput(value);
    const hex = normalizeHex(value);
    if (hex && accentProblem(hex) === null) change({ accent: hex });
  }

  function resetToDefaults() {
    if (!canEdit || !draft) return;
    setHexInput(DEFAULT_PHARMACY_APPEARANCE.accent);
    change({ ...DEFAULT_PHARMACY_APPEARANCE });
  }

  async function save(): Promise<boolean> {
    if (!canEdit || !saved || !draft) return true;
    // A typed colour that can't be saved is refused, even when the swatches are unchanged.
    if (hexProblem !== null) return false;
    if (!dirty) return true;
    setSaving(true);
    setMessage(null);
    try {
      const brand = await savePharmacyBrand(saved.version, draft);
      adoptPharmacyBrand(brand);
      setMessage({ kind: "ok", text: "Saved for everyone at the pharmacy." });
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const latest = await fetchPharmacyBrand().catch(() => null);
        if (latest) adoptPharmacyBrand(latest);
        setMessage({
          kind: "error",
          text: "Another owner changed the brand while you were editing. Their version is shown now; make your change again.",
        });
      } else {
        setMessage({
          kind: "error",
          text: e instanceof Error ? e.message : "Could not save the brand.",
        });
      }
      return false;
    } finally {
      setSaving(false);
    }
  }

  useImperativeHandle(ref, () => ({ save, resetToDefaults }));

  const disabled = !canEdit || !draft || saving;
  const presetHit = draft
    ? ACCENT_PRESETS.find((p) => p.hex === draft.accent)
    : undefined;

  return (
    <section className={css.card} aria-labelledby="pharmacy-brand-title">
      <div className={css.cardHead}>
        <div>
          <h2 className={css.cardTitle} id="pharmacy-brand-title">
            <IconShield size={16} /> Pharmacy brand
            <span className={css.scopeChip}>Everyone · owner only</span>
          </h2>
          <p className={css.cardDesc}>
            The colours everyone at the pharmacy sees, on every computer. Light
            or dark, density and text size above stay each person&apos;s own.
          </p>
        </div>
        {!canEdit && (
          <span className={css.badgeLocked}>
            <IconLock size={12} /> Only an owner can change this
          </span>
        )}
      </div>

      {loadError && <p className={css.saveError}>{loadError}</p>}

      <p className={css.subLabel}>Accent colour</p>
      <div className={css.swatchRow} role="group" aria-label="Accent colour">
        {ACCENT_PRESETS.map((p) => {
          const on = draft?.accent === p.hex;
          return (
            <button
              key={p.hex}
              type="button"
              aria-label={`${p.name} accent`}
              aria-pressed={on}
              title={p.name}
              className={`${css.swatch}${on ? ` ${css.swatchSelected}` : ""}`}
              style={
                {
                  background: p.hex,
                  color: "#fff",
                  "--swatch-ring": p.hex,
                } as React.CSSProperties
              }
              onClick={() => pickAccent(p.hex)}
              disabled={disabled}
            >
              {on ? <IconCheck size={15} /> : null}
            </button>
          );
        })}
      </div>
      {canEdit && (
        <div className={css.brandHex}>
          <FormField
            label="Or your own colour"
            value={hexInput}
            onChange={(e) => typeAccent(e.target.value)}
            placeholder="#0f766e"
            spellCheck={false}
            autoComplete="off"
            maxLength={7}
            error={hexProblem ?? undefined}
            hint={
              hexProblem
                ? undefined
                : presetHit
                  ? `${presetHit.name}, one of the presets.`
                  : "Must be dark enough to read on white."
            }
            disabled={disabled}
          />
        </div>
      )}

      <p className={css.subLabel}>Sidebar</p>
      <div className={css.pillRow} role="group" aria-label="Sidebar">
        {SIDEBAR_CHOICES.map((c) => (
          <button
            key={c.value}
            type="button"
            aria-pressed={draft?.sidebarStyle === c.value}
            className={`${css.pill}${draft?.sidebarStyle === c.value ? ` ${css.pillSelected}` : ""}`}
            onClick={() => change({ sidebarStyle: c.value })}
            disabled={disabled}
          >
            {c.label}
          </button>
        ))}
      </div>

      <p className={css.subLabel}>Status colours</p>
      <div className={css.pillRow} role="group" aria-label="Status colours">
        {STATUS_CHOICES.map((c) => (
          <button
            key={c.value}
            type="button"
            aria-pressed={draft?.statusSet === c.value}
            className={`${css.pill}${draft?.statusSet === c.value ? ` ${css.pillSelected}` : ""}`}
            onClick={() => change({ statusSet: c.value })}
            disabled={disabled}
          >
            {c.label}
          </button>
        ))}
      </div>
      <p className={css.rowHint}>
        Colour-blind safe uses status colours that stay distinct for people with
        red-green colour blindness.
      </p>

      <p className={css.subLabel}>Chart colours</p>
      <div className={css.pillRow} role="group" aria-label="Chart colours">
        {CHART_CHOICES.map((c) => (
          <button
            key={c.value}
            type="button"
            aria-pressed={draft?.chartPalette === c.value}
            className={`${css.pill}${draft?.chartPalette === c.value ? ` ${css.pillSelected}` : ""}`}
            onClick={() => change({ chartPalette: c.value })}
            disabled={disabled}
          >
            <span className={css.chartStrip} aria-hidden="true">
              {[1, 2, 3, 4, 5, 6].map((n) => (
                <i
                  key={n}
                  style={{ background: `var(--ui-chart-${c.set}-${n})` }}
                />
              ))}
            </span>
            {c.label}
          </button>
        ))}
      </div>
      <p className={css.rowHint}>
        Brand colours start from your accent. Distinct colours are the same for
        every pharmacy and easier to tell apart when a chart has many series.
      </p>

      <p className={css.subLabel}>Counter app theme</p>
      <div className={css.pillRow} role="group" aria-label="Counter app theme">
        {COUNTER_THEME_CHOICES.map((c) => (
          <button
            key={c.value}
            type="button"
            aria-pressed={draft?.counterTheme === c.value}
            className={`${css.pill}${draft?.counterTheme === c.value ? ` ${css.pillSelected}` : ""}`}
            onClick={() => change({ counterTheme: c.value })}
            disabled={disabled}
          >
            {c.label}
          </button>
        ))}
      </div>
      <div className={css.brandLock}>
        <ToggleSwitch
          label="Lock it on every counter"
          checked={draft?.counterThemeLocked ?? false}
          onChange={(locked) => change({ counterThemeLocked: locked })}
          disabled={disabled}
        />
        <span>Lock it on every counter</span>
      </div>
      <p className={css.rowHint}>
        Where the desktop counter app starts. Cashiers can switch with the
        sun/moon button on their own computer unless you lock it; locked, every
        counter shows this theme and the button is hidden. Counters pick up a
        change when someone next signs in, or within five minutes.
      </p>

      {message && (
        <p className={message.kind === "ok" ? css.saveOk : css.saveError} role="status">
          {message.text}
        </p>
      )}
    </section>
  );
});
