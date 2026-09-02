"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import { fetchOnboardingDraft, OnboardingDraft, saveOnboardingDraft } from "@/lib/onboarding-draft-client";
import styles from "./onboarding.module.css";

type Step = "pharmacy" | "branch" | "preferences" | "review";
const steps: Array<{ key: Step; label: string; path: string }> = [
  { key: "pharmacy", label: "Your pharmacy", path: "/onboarding/pharmacy" },
  { key: "branch", label: "First branch", path: "/onboarding/branch" },
  { key: "preferences", label: "Preferences", path: "/onboarding/preferences" },
  { key: "review", label: "Review", path: "/onboarding/review" },
];

export function OnboardingWizard({ step }: { step: Step }) {
  const router = useRouter();
  const index = steps.findIndex((item) => item.key === step);
  const [draft, setDraft] = useState<OnboardingDraft>({ currentStep: 1 });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void fetchOnboardingDraft().then((result) => setDraft(result.draft)).catch((cause) => setError(cause instanceof Error ? cause.message : "Unable to load setup")).finally(() => setLoading(false));
  }, []);

  function update<K extends keyof OnboardingDraft>(key: K, value: OnboardingDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function continueSetup() {
    setError(null);
    if (step === "pharmacy" && !draft.businessName?.trim()) return setError("Enter your pharmacy business name.");
    if (step === "branch" && (!draft.branchName?.trim() || !draft.addressLine1?.trim())) return setError("Enter the branch name and operating address.");
    setSaving(true);
    try {
      const nextStep = Math.min(4, index + 2);
      const result = await saveOnboardingDraft({ ...draft, currentStep: nextStep });
      setDraft(result.draft);
      if (step === "review") setSaved(true);
      else router.push(steps[index + 1].path);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save setup");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <main className={styles.loading}>Loading your setup…</main>;

  return (
    <main className={styles.page}>
      <header className={styles.header}><Link href="/login" className={styles.logo}>PharmaCeylon</Link><span>Workspace setup is saved automatically when you continue.</span></header>
      <div className={styles.shell}>
        <aside className={styles.sidebar}>
          <p className={styles.eyebrow}>PHARMACY SETUP</p>
          <h1>Let’s set up your pharmacy</h1>
          <p>Start with the essentials. You can refine these details later in Settings.</p>
          <ol>{steps.map((item, itemIndex) => <li key={item.key} className={item.key === step ? styles.active : itemIndex < index ? styles.done : ""}><span>{itemIndex < index ? "✓" : itemIndex + 1}</span><div><b>{item.label}</b><small>{itemIndex < index ? "Saved" : item.key === step ? "In progress" : "Not started"}</small></div></li>)}</ol>
        </aside>
        <section className={styles.card}>
          <div className={styles.stepLabel}>STEP {index + 1} OF 4</div>
          {step === "pharmacy" ? <PharmacyForm draft={draft} update={update} /> : null}
          {step === "branch" ? <BranchForm draft={draft} update={update} /> : null}
          {step === "preferences" ? <PreferencesForm draft={draft} update={update} /> : null}
          {step === "review" ? <Review draft={draft} saved={saved} /> : null}
          {error ? <Alert variant="error">{error}</Alert> : null}
          <div className={styles.actions}>
            {index > 0 ? <Link className={styles.back} href={steps[index - 1].path}>Back</Link> : <span />}
            <button className={styles.primary} onClick={continueSetup} disabled={saving}>{saving ? "Saving…" : step === "review" ? "Save setup draft" : "Continue"}</button>
          </div>
        </section>
      </div>
    </main>
  );
}

type Update = <K extends keyof OnboardingDraft>(key: K, value: OnboardingDraft[K]) => void;
function PharmacyForm({ draft, update }: { draft: OnboardingDraft; update: Update }) { return <><h2>Tell us about your pharmacy</h2><p className={styles.lead}>These details identify the business that owns your branches.</p><div className={styles.form}><Field label="Business name" value={draft.businessName} onChange={(v) => update("businessName", v)} required /><Field label="Legal name (optional)" value={draft.legalName} onChange={(v) => update("legalName", v)} /><div className={styles.grid3}><Field label="Country" value={draft.country} onChange={(v) => update("country", v)} /><Field label="Currency" value={draft.currency} onChange={(v) => update("currency", v)} /><Field label="Time zone" value={draft.timezone} onChange={(v) => update("timezone", v)} /></div><div className={styles.grid2}><Field label="Business email" type="email" value={draft.businessEmail} onChange={(v) => update("businessEmail", v)} /><Field label="Business phone" value={draft.businessPhone} onChange={(v) => update("businessPhone", v)} /></div></div></>; }
function BranchForm({ draft, update }: { draft: OnboardingDraft; update: Update }) { return <><h2>Create your first branch</h2><p className={styles.lead}>Start with one operating location. You can add more later.</p><div className={styles.form}><div className={styles.grid2}><Field label="Branch name" value={draft.branchName} onChange={(v) => update("branchName", v)} required /><Field label="Branch code" value={draft.branchCode} onChange={(v) => update("branchCode", v.toUpperCase())} placeholder="MAIN" /></div><Field label="Operating address" value={draft.addressLine1} onChange={(v) => update("addressLine1", v)} required /><div className={styles.grid2}><Field label="City" value={draft.city} onChange={(v) => update("city", v)} /><Field label="District" value={draft.district} onChange={(v) => update("district", v)} /></div><label className={styles.check}><input type="checkbox" checked={draft.useBusinessPhone ?? true} onChange={(e) => update("useBusinessPhone", e.target.checked)} />Use the business phone for this branch</label>{draft.useBusinessPhone === false ? <Field label="Branch phone" value={draft.branchPhone} onChange={(v) => update("branchPhone", v)} /> : null}</div></>; }
function PreferencesForm({ draft, update }: { draft: OnboardingDraft; update: Update }) { const payments=draft.paymentMethods ?? ["cash", "card"]; return <><h2>Set your starting preferences</h2><p className={styles.lead}>Choose a sensible starting point. Detailed policies remain in Settings.</p><div className={styles.form}><div className={styles.choiceRow}>{(["fresh", "migrating"] as const).map((mode) => <button type="button" key={mode} className={`${styles.choice} ${draft.migrationMode === mode ? styles.selected : ""}`} onClick={() => update("migrationMode", mode)}><b>{mode === "fresh" ? "Starting fresh" : "Moving from another system"}</b><span>{mode === "fresh" ? "Build your catalog and stock from scratch." : "We’ll prioritize opening inventory import."}</span></button>)}</div><Field label="Receipt display name" value={draft.receiptDisplayName ?? draft.businessName} onChange={(v) => update("receiptDisplayName", v)} /><fieldset><legend>Initial payment methods</legend><div className={styles.paymentRow}>{["cash", "card", "mobile_wallet", "credit"].map((method) => <label key={method} className={styles.check}><input type="checkbox" checked={payments.includes(method)} onChange={(e) => update("paymentMethods", e.target.checked ? [...payments, method] : payments.filter((item) => item !== method))} />{method.replace("_", " ")}</label>)}</div></fieldset></div></>; }
function Review({ draft, saved }: { draft: OnboardingDraft; saved: boolean }) { return <><h2>Review your setup</h2><p className={styles.lead}>Your answers remain editable and resumable. Workspace creation is handled in Phase 3.</p>{saved ? <Alert variant="success">Your setup draft is saved. You can safely return on another browser session.</Alert> : null}<div className={styles.summary}><Summary title="Pharmacy" rows={[draft.businessName, `${draft.country ?? "LK"} · ${draft.currency ?? "LKR"} · ${draft.timezone ?? "Asia/Colombo"}`, draft.businessEmail]} /><Summary title="First branch" rows={[draft.branchName, draft.addressLine1, [draft.city, draft.district].filter(Boolean).join(", ")]} /><Summary title="Preferences" rows={[draft.migrationMode === "migrating" ? "Moving from another system" : "Starting fresh", `Payments: ${(draft.paymentMethods ?? []).join(", ")}`]} /></div></>; }
function Field({ label, value, onChange, type="text", required=false, placeholder }: { label: string; value?: string; onChange: (value: string) => void; type?: string; required?: boolean; placeholder?: string }) { return <label>{label}{required ? " *" : ""}<input type={type} value={value ?? ""} onChange={(e) => onChange(e.target.value)} required={required} placeholder={placeholder} /></label>; }
function Summary({ title, rows }: { title: string; rows: Array<string | undefined> }) { return <div><h3>{title}</h3>{rows.filter(Boolean).map((row) => <p key={row}>{row}</p>)}</div>; }
