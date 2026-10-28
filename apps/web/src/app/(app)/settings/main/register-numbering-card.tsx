"use client";

import {
  MAX_REGISTER_PREFIX_LENGTH,
  ONLINE_INVOICE_PREFIX,
  type CounterPolicyView,
  type RegisterNumbering,
} from "@pharmaceylon/shared";
import { FormField } from "@/components/ui";
import css from "../settings.module.css";
import { CounterPolicySection, SyncNote } from "../lib/counter-policy";

/** Per-register receipt and invoice prefixes, so two counters selling offline can't issue the
 * same number. Registers themselves are added in Settings → Counters (W6). */
export function RegisterNumberingCard() {
  return (
    <CounterPolicySection
      title="Register numbering"
      saveLabel="Save numbering"
      validate={halfFilled}
      description={
        <>
          <p className={css.cardDesc}>
            Each register numbers its own receipts and invoices. Give every series its own
            prefix: none may begin another, or the online {ONLINE_INVOICE_PREFIX} series. Letters,
            digits and hyphens, up to {MAX_REGISTER_PREFIX_LENGTH} characters.
          </p>
          <SyncNote>Numbers already issued keep their prefix.</SyncNote>
        </>
      }
    >
      {({ view, disabled, edit }) =>
        view.registers.length === 0 ? (
          <p className={css.rowHint}>
            This branch has no registers yet. They appear here once a counter is set up.
          </p>
        ) : (
          view.registers.map((register) => {
            const row = numberingFor(view, register.registerId);
            const set = (patch: Partial<RegisterNumbering>) =>
              edit({
                ...view.policy,
                registerNumbering: upsert(view, { ...row, ...patch }),
              });
            const name = register.isActive ? register.label : `${register.label} (retired)`;
            return (
              <div key={register.registerId} className={css.formGrid}>
                <FormField
                  label={`${name} receipt prefix`}
                  value={row.receiptPrefix}
                  maxLength={MAX_REGISTER_PREFIX_LENGTH}
                  // A retired register keeps its series, so a new one can't reuse its numbers.
                  disabled={disabled || !register.isActive}
                  onChange={(e) => set({ receiptPrefix: e.target.value.toUpperCase() })}
                />
                <FormField
                  label={`${name} invoice prefix`}
                  value={row.invoicePrefix}
                  maxLength={MAX_REGISTER_PREFIX_LENGTH}
                  disabled={disabled || !register.isActive}
                  onChange={(e) => set({ invoicePrefix: e.target.value.toUpperCase() })}
                />
              </div>
            );
          })
        )
      }
    </CounterPolicySection>
  );
}

/** One prefix without the other would be refused as malformed; say which register and field. */
function halfFilled(view: CounterPolicyView): string | null {
  for (const row of view.policy.registerNumbering) {
    const missing = !row.receiptPrefix.trim()
      ? "receipt prefix"
      : !row.invoicePrefix.trim()
        ? "invoice prefix"
        : null;
    if (!missing) continue;
    const register = view.registers.find((r) => r.registerId === row.registerId);
    const name = register?.label ?? "A register";
    return `${name}: fill in the ${missing} too, or clear both to leave it unnumbered.`;
  }
  return null;
}

function numberingFor(view: CounterPolicyView, registerId: string): RegisterNumbering {
  return (
    view.policy.registerNumbering.find((r) => r.registerId === registerId) ?? {
      registerId,
      receiptPrefix: "",
      invoicePrefix: "",
    }
  );
}

/** Both prefixes blank means "not numbered yet", which is stored as no entry at all. */
function upsert(view: CounterPolicyView, row: RegisterNumbering): RegisterNumbering[] {
  const others = view.policy.registerNumbering.filter((r) => r.registerId !== row.registerId);
  return row.receiptPrefix || row.invoicePrefix ? [...others, row] : others;
}
