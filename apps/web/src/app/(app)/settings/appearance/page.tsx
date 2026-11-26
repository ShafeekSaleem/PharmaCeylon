"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ActionButton, PageHeader } from "@/components/ui";
import { IconMoon, IconSparkles, IconSun, IconUser } from "@/components/icons";
import { useAuth } from "@/lib/use-auth";
import { useUnsavedChangesWarning } from "@/lib/use-unsaved-changes";
import {
  APPEARANCE_CHANGED_EVENT,
  applyAppearancePrefs,
  readAppearancePrefs,
  saveAppearancePrefs,
  DEFAULT_APPEARANCE_PREFS,
  type AppearancePrefs,
  type Density,
  type FontSize,
  type Theme,
} from "@/lib/appearance";
import css from "../settings.module.css";
import page from "./appearance.module.css";
import { AppearancePreview } from "./appearance-preview";
import {
  PharmacyBrandCard,
  isOwner,
  type PharmacyBrandHandle,
  type PharmacyBrandState,
} from "./pharmacy-brand-card";

type Choice<T> = { value: T; label: string; icon?: React.ReactNode };

const THEME_CHOICES: Choice<Theme>[] = [
  { value: "light", label: "Light", icon: <IconSun size={14} /> },
  { value: "dark", label: "Dark", icon: <IconMoon size={14} /> },
  { value: "system", label: "Match device", icon: <IconSparkles size={14} /> },
];
const DENSITY_CHOICES: Choice<Density>[] = [
  { value: "comfortable", label: "Comfortable" },
  { value: "compact", label: "Compact" },
];
const TEXT_CHOICES: Choice<FontSize>[] = [
  { value: "small", label: "Small" },
  { value: "medium", label: "Default" },
  { value: "large", label: "Large" },
];

const samePrefs = (a: AppearancePrefs, b: AppearancePrefs) =>
  a.theme === b.theme && a.density === b.density && a.fontSize === b.fontSize;

/**
 * Settings › Appearance (UI1 #205): the person's own display, and the pharmacy brand for owners.
 * Every choice shows straight away, on the page and in the preview, and is kept only on Save.
 * Leaving without saving puts back what was saved, and asks first.
 */
export default function AppearancePage() {
  const { user } = useAuth();
  const userId = user?.id;
  const owner = isOwner(user);
  const [saved, setSaved] = useState(DEFAULT_APPEARANCE_PREFS);
  const [draft, setDraft] = useState(DEFAULT_APPEARANCE_PREFS);
  const [ready, setReady] = useState(false);
  const [brand, setBrand] = useState<PharmacyBrandState>({ dirty: false, invalid: false });
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const brandRef = useRef<PharmacyBrandHandle>(null);
  const savedRef = useRef(saved);
  savedRef.current = saved;

  useEffect(() => {
    const prefs = readAppearancePrefs(userId);
    setSaved(prefs);
    setDraft(prefs);
    setReady(true);
    // The top-bar switch saves a theme from outside this page: it becomes the saved theme here
    // too, and replaces any theme picked but not saved, leaving the other choices as drafted.
    const onChange = (e: Event) => {
      const next = (e as CustomEvent<AppearancePrefs>).detail;
      setSaved(next);
      setDraft((d) => ({ ...d, theme: next.theme }));
    };
    window.addEventListener(APPEARANCE_CHANGED_EVENT, onChange);
    return () => {
      window.removeEventListener(APPEARANCE_CHANGED_EVENT, onChange);
      // Leaving with a display that wasn't saved puts the saved one back.
      applyAppearancePrefs(savedRef.current);
    };
  }, [userId]);

  // The draft is the live preview: the whole page shows it before it is saved.
  useEffect(() => {
    if (ready) applyAppearancePrefs(draft);
  }, [draft, ready]);

  const displayDirty = ready && !samePrefs(draft, saved);
  const dirty = displayDirty || brand.dirty;
  useUnsavedChangesWarning(dirty);

  const onBrandState = useCallback((state: PharmacyBrandState) => setBrand(state), []);

  function choose(next: Partial<AppearancePrefs>) {
    setNotice(null);
    setDraft((d) => ({ ...d, ...next }));
  }

  async function save() {
    setSaving(true);
    setNotice(null);
    if (displayDirty) {
      saveAppearancePrefs(draft, userId);
      setSaved(draft);
    }
    // The brand card says itself whether the pharmacy's brand saved, and why not.
    const brandSaved = brand.dirty ? await brandRef.current?.save() : true;
    setSaving(false);
    if (displayDirty) setNotice(brandSaved ? "Saved." : "Your display is saved.");
  }

  function reset() {
    setNotice(null);
    setDraft(DEFAULT_APPEARANCE_PREFS);
    brandRef.current?.resetToDefaults();
  }

  const atDefaults = samePrefs(draft, DEFAULT_APPEARANCE_PREFS);

  return (
    <div>
      <PageHeader
        title="Appearance"
        description="Changes show straight away, on this page and in the preview, and are kept when you press Save."
      />

      <div className={page.layout}>
        <div className={page.grid}>
          <div className={page.form}>
            <section className={css.card} aria-labelledby="your-display-title">
              <h2 className={css.cardTitle} id="your-display-title">
                <IconUser size={16} /> Your display
                <span className={css.scopeChip}>Only your account</span>
              </h2>
              <p className={css.cardDesc}>
                On this browser. Everyone at the pharmacy picks their own.
              </p>

              <ChoiceRow
                label="Theme"
                hint="Also on the top bar of every page."
                choices={THEME_CHOICES}
                value={draft.theme}
                onChange={(theme) => choose({ theme })}
                disabled={!ready}
              />
              <ChoiceRow
                label="Density"
                hint="Compact fits more rows in tables."
                choices={DENSITY_CHOICES}
                value={draft.density}
                onChange={(density) => choose({ density })}
                disabled={!ready}
              />
              <ChoiceRow
                label="Text size"
                choices={TEXT_CHOICES}
                value={draft.fontSize}
                onChange={(fontSize) => choose({ fontSize })}
                disabled={!ready}
              />
            </section>

            <PharmacyBrandCard ref={brandRef} user={user} onStateChange={onBrandState} />

            <div className={page.saveBar}>
              <ActionButton onClick={save} disabled={!dirty || saving || brand.invalid}>
                {saving ? "Saving…" : "Save changes"}
              </ActionButton>
              <ActionButton
                variant="secondary"
                onClick={reset}
                disabled={!ready || saving || (atDefaults && !owner)}
              >
                Reset to defaults
              </ActionButton>
              <span className={page.saveState} role="status">
                {dirty ? "Unsaved changes" : notice}
              </span>
            </div>
            <p className={css.rowHint}>
              {owner
                ? "Reset puts back the PharmaCeylon defaults for your display and the pharmacy brand. Nothing changes until you save."
                : "Reset puts back the PharmaCeylon defaults for your display. Nothing changes until you save."}
            </p>
          </div>

          <AppearancePreview />
        </div>
      </div>
    </div>
  );
}

function ChoiceRow<T extends string>({
  label,
  hint,
  choices,
  value,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  choices: Choice<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled: boolean;
}) {
  return (
    <div className={page.choiceRow}>
      <div className={page.choiceLabel}>
        <span className={css.rowLabel}>{label}</span>
        {hint ? <span className={css.rowHint}>{hint}</span> : null}
      </div>
      <div className={page.segmented} role="group" aria-label={label}>
        {choices.map((choice) => (
          <button
            key={choice.value}
            type="button"
            aria-pressed={value === choice.value}
            className={page.segment}
            onClick={() => onChange(choice.value)}
            disabled={disabled}
          >
            {choice.icon}
            {choice.label}
          </button>
        ))}
      </div>
    </div>
  );
}
