import { StatusBadge } from "@/components/ui";
import css from "../settings.module.css";
import { pendingNote } from "../lib/pending-settings";
import type { TenantSettings } from "../lib/tenant-settings";

/**
 * Marks a setting that persists but isn't enforced yet.
 *
 * Reuses the same `StatusBadge status="soon"` treatment the Recipients &
 * Channels page already applies to SMS alerts, so an inactive control reads the
 * same way wherever it appears in Settings.
 */
export function PendingBadge() {
  return <StatusBadge status="soon" label="Not active yet" variant="muted" />;
}

/**
 * The label + hint half of a settings row, with the pending badge and the honest
 * "what actually happens" note appended when the key is on the pending list.
 *
 * Every Settings page renders rows with the same `rowLabel` / `rowHint` shape,
 * so this replaces that markup rather than wrapping it — one place decides how
 * an unimplemented setting looks.
 */
/**
 * Same treatment for `FormField` / `SelectField`, which own their own label and
 * hint markup instead of taking a label block. Spread over the control:
 *
 *   <SelectField label="…" {...pendingFieldProps("stockPickingMethod", { disabled: !canEdit })} />
 *
 * The note is appended to any existing hint rather than replacing it, so a
 * field keeps whatever it already explained about itself.
 */
export function pendingFieldProps(
  settingKey: keyof TenantSettings,
  base: { hint?: string; disabled?: boolean } = {},
): { hint?: string; disabled: boolean } {
  const note = pendingNote(settingKey);
  if (!note) return { hint: base.hint, disabled: Boolean(base.disabled) };
  return {
    hint: base.hint ? `${base.hint} Not active yet — ${lowerFirst(note)}` : `Not active yet — ${lowerFirst(note)}`,
    disabled: true,
  };
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

export function SettingLabel({
  settingKey,
  label,
  hint,
}: {
  settingKey: keyof TenantSettings;
  label: string;
  hint?: string;
}) {
  const note = pendingNote(settingKey);
  return (
    <div>
      <div className={css.rowLabel}>
        {label} {note ? <PendingBadge /> : null}
      </div>
      {hint ? <div className={css.rowHint}>{hint}</div> : null}
      {note ? <div className={css.rowHint}>{note}</div> : null}
    </div>
  );
}
