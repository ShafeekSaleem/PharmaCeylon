"use client";

import { useEffect, useRef, useState } from "react";
import {
  ACCENT_PRESETS,
  accentProblem,
  normalizeHex,
  type CounterThemeDefault,
  type PharmacyAppearance,
  type PharmacyAppearanceSettings,
  type SidebarStyle,
  type StatusColourSet,
} from "@pharmaceylon/shared";
import { ActionButton, FormField, ToggleSwitch } from "@/components/ui";
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

/**
 * The pharmacy brand (UI1 #205): one accent, sidebar style and status colour set for everyone at
 * the pharmacy. Owners edit it here with a live preview that is put back if they leave unsaved;
 * everyone else sees what was chosen. The API refuses the same accents this form does.
 */
export function PharmacyBrandCard({ user }: { user: AuthUser | null }) {
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
  const dirty = saved !== null && draft !== null && !same(saved, draft);

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

  function undo() {
    if (saved) take(saved);
    setMessage(null);
  }

  async function save() {
    if (!saved || !draft) return;
    setSaving(true);
    setMessage(null);
    try {
      const brand = await savePharmacyBrand(saved.version, draft);
      adoptPharmacyBrand(brand);
      setMessage({ kind: "ok", text: "Saved for everyone at the pharmacy." });
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
    } finally {
      setSaving(false);
    }
  }

  const disabled = !canEdit || !draft || saving;
  const presetHit = draft
    ? ACCENT_PRESETS.find((p) => p.hex === draft.accent)
    : undefined;

  return (
    <div className={css.card} aria-labelledby="pharmacy-brand-title">
      <div className={css.cardHead}>
        <div>
          <h2 className={css.cardTitle} id="pharmacy-brand-title">
            <IconShield size={16} /> Pharmacy brand
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

      {canEdit && (
        <div className={css.saveRow}>
          {message && (
            <span
              className={message.kind === "ok" ? css.saveOk : css.saveError}
            >
              {message.text}
            </span>
          )}
          {!message && dirty && (
            <span className={css.rowHint}>Previewing. Not saved yet.</span>
          )}
          <ActionButton
            variant="secondary"
            onClick={undo}
            disabled={!dirty || saving}
          >
            Undo changes
          </ActionButton>
          <ActionButton
            onClick={save}
            disabled={!dirty || saving || hexProblem !== null}
          >
            {saving ? "Saving…" : "Save for the pharmacy"}
          </ActionButton>
        </div>
      )}
    </div>
  );
}
