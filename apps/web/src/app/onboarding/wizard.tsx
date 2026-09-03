"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Alert } from "@/components/alert";
import {
  IconCheck,
  IconCheckCircle,
  IconChevronLeft,
  IconChevronRight,
  IconCloud,
  IconEdit,
  IconFirstAid,
  IconHome,
  IconInfo,
  IconMapPin,
  IconPackage,
  IconReceipt,
  IconSave,
  IconSettings,
  IconShield,
  IconUpload,
  IconUser,
} from "@/components/icons";
import { ImageUpload } from "@/components/ui/image-upload";
import { SelectField } from "@/components/ui/select-field";
import {
  COUNTRY_OPTIONS,
  CURRENCY_OPTIONS,
  DATE_FORMAT_OPTIONS,
  PHONE_CODE_OPTIONS,
  PROVINCE_OPTIONS,
  TIMEZONE_OPTIONS,
  countryDefaults,
  districtsForProvince,
  optionLabel,
} from "@/lib/onboarding-options";
import {
  completeOnboarding,
  fetchOnboardingDraft,
  OnboardingDraft,
  removeOnboardingLogo,
  saveOnboardingDraft,
} from "@/lib/onboarding-draft-client";
import {
  fetchOwnerRegistrationStatus,
  type VerifiedOwnerSession,
} from "@/lib/owner-registration-client";
import styles from "./onboarding.module.css";

/**
 * Mirrors ONBOARDING_DEPARTMENT_GROUPS in the API's commercial-category-template. The API
 * validates `sellsDepartments` against the same labels, so the two lists have to stay in step.
 */
const SELLS_DEPARTMENTS = [
  "Medicines",
  "Vitamins & Supplements",
  "Baby & Mother Care",
  "Personal Care",
  "Beauty & Skin Care",
  "Medical Devices & First Aid",
  "Nutrition & Wellness",
  "Food & Beverages",
  "Household & Convenience",
];

type Step = "pharmacy" | "branch" | "preferences" | "review";
type SaveState = "saved" | "saving" | "unsaved" | "error";
type Update = <K extends keyof OnboardingDraft>(
  key: K,
  value: OnboardingDraft[K],
) => void;
type Patch = (values: Partial<OnboardingDraft>) => void;

const steps: Array<{
  key: Step;
  label: string;
  description: string;
  path: string;
}> = [
  {
    key: "pharmacy",
    label: "Your pharmacy",
    description: "Tell us about your pharmacy business.",
    path: "/onboarding/pharmacy",
  },
  {
    key: "branch",
    label: "First branch",
    description: "Add your main branch location.",
    path: "/onboarding/branch",
  },
  {
    key: "preferences",
    label: "Preferences",
    description: "Set your starting preferences.",
    path: "/onboarding/preferences",
  },
  {
    key: "review",
    label: "Review",
    description: "Check your details before creation.",
    path: "/onboarding/review",
  },
];

export function OnboardingWizard({ step }: { step: Step }) {
  const router = useRouter();
  const index = steps.findIndex((item) => item.key === step);
  const [draft, setDraft] = useState<OnboardingDraft>({ currentStep: 1 });
  const [owner, setOwner] = useState<VerifiedOwnerSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const persisted = useRef("");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void Promise.all([fetchOnboardingDraft(), fetchOwnerRegistrationStatus()])
      .then(([draftResult, ownerResult]) => {
        setDraft(draftResult.draft);
        setOwner(ownerResult);
        persisted.current = JSON.stringify(draftResult.draft);
      })
      .catch((cause) =>
        setError(
          cause instanceof Error ? cause.message : "Unable to load your setup",
        ),
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (loading) return;
    const payload = {
      ...draft,
      currentStep: Math.max(draft.currentStep, index + 1),
    };
    if (JSON.stringify(payload) === persisted.current) return;
    setSaveState("unsaved");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      setSaveState("saving");
      void saveOnboardingDraft(payload)
        .then((result) => {
          persisted.current = JSON.stringify(result.draft);
          setSaveState("saved");
        })
        .catch(() => setSaveState("error"));
    }, 900);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [draft, index, loading]);

  function update<K extends keyof OnboardingDraft>(
    key: K,
    value: OnboardingDraft[K],
  ) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function patch(values: Partial<OnboardingDraft>) {
    setDraft((current) => ({ ...current, ...values }));
  }

  async function saveAndNavigate(
    path?: string,
    nextStep = Math.max(draft.currentStep, index + 1),
  ) {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveState("saving");
    const result = await saveOnboardingDraft({
      ...draft,
      currentStep: nextStep,
    });
    setDraft(result.draft);
    persisted.current = JSON.stringify(result.draft);
    setSaveState("saved");
    if (path) router.push(path);
  }

  async function continueSetup() {
    setError(null);
    if (step === "pharmacy" && !draft.businessName?.trim()) {
      setError("Enter your pharmacy business name.");
      return;
    }
    if (
      step === "branch" &&
      (!draft.branchName?.trim() || !draft.addressLine1?.trim())
    ) {
      setError("Enter the branch name and operating address.");
      return;
    }
    if (step === "preferences" && !draft.paymentMethods?.length) {
      setError("Select at least one payment method.");
      return;
    }
    try {
      if (step === "review") {
        await saveAndNavigate(undefined, 4);
        setCreating(true);
        const result = await completeOnboarding();
        router.replace(result.nextPath);
        return;
      }
      await saveAndNavigate(steps[index + 1].path, index + 2);
    } catch (cause) {
      setCreating(false);
      setSaveState("error");
      setError(
        cause instanceof Error ? cause.message : "Unable to save your setup",
      );
    }
  }

  async function goTo(path: string) {
    try {
      await saveAndNavigate(path);
    } catch (cause) {
      setSaveState("error");
      setError(
        cause instanceof Error ? cause.message : "Unable to save your setup",
      );
    }
  }

  if (loading)
    return (
      <main className={styles.loading}>
        <span className={styles.loadingMark}>
          <IconFirstAid size={24} />
        </span>
        <b>Loading your workspace setup…</b>
      </main>
    );

  const initials =
    `${owner?.firstName?.[0] ?? ""}${owner?.lastName?.[0] ?? ""}` || "OW";
  const reachedStep = Math.max(draft.currentStep, index + 1);

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerTitle}>
          <Link href="/login" className={styles.brand}>
            <span>
              <IconFirstAid size={19} />
            </span>
            PharmaCeylon
          </Link>
          <i />
          <b>Workspace setup</b>
        </div>
        <div className={styles.ownerSummary}>
          <span className={styles.avatar}>{initials}</span>
          <div>
            <b>
              {owner
                ? `${owner.firstName} ${owner.lastName}`
                : "Pharmacy owner"}
            </b>
            <small>{owner?.email}</small>
          </div>
          <span className={styles.verifiedBadge} title="Email verified">
            <IconCheck size={12} />
          </span>
        </div>
      </header>

      <div className={styles.workspace}>
        <aside className={styles.sidebar}>
          <p className={styles.sidebarLabel}>LET&apos;S GET YOU STARTED</p>
          <ol>
            {steps.map((item, itemIndex) => {
              const active = item.key === step;
              const complete = itemIndex + 1 < reachedStep;
              const accessible = itemIndex + 1 <= reachedStep;
              return (
                <li
                  key={item.key}
                  className={
                    active
                      ? styles.activeStep
                      : complete
                        ? styles.completeStep
                        : ""
                  }
                >
                  <button
                    type="button"
                    disabled={!accessible || active}
                    onClick={() => void goTo(item.path)}
                  >
                    <span>
                      {complete ? <IconCheck size={16} /> : itemIndex + 1}
                    </span>
                    <div>
                      <b>{item.label}</b>
                      <small>{item.description}</small>
                    </div>
                  </button>
                </li>
              );
            })}
          </ol>
          <div className={styles.progressSummary}>
            <IconCloud size={23} />
            <div>
              <b>
                {Math.round(((index + 1) / steps.length) * 100)}% through setup
              </b>
              <span>Your progress is saved as you go.</span>
            </div>
          </div>
        </aside>

        <section className={styles.content}>
          <div className={styles.formCard}>
            <div className={styles.stepLabel}>STEP {index + 1} OF 4</div>
            {step === "pharmacy" ? (
              <PharmacyForm draft={draft} update={update} patch={patch} />
            ) : null}
            {step === "branch" ? (
              <BranchForm draft={draft} update={update} patch={patch} />
            ) : null}
            {step === "preferences" ? (
              <PreferencesForm draft={draft} update={update} />
            ) : null}
            {step === "review" ? (
              <Review draft={draft} owner={owner} goTo={goTo} />
            ) : null}
            {error ? <Alert variant="error">{error}</Alert> : null}
            <div className={styles.actions}>
              <div>
                {index > 0 ? (
                  <button
                    type="button"
                    className={styles.back}
                    onClick={() => void goTo(steps[index - 1].path)}
                  >
                    <IconChevronLeft size={17} />
                    Back
                  </button>
                ) : (
                  <button
                    type="button"
                    className={styles.exit}
                    onClick={() => void goTo("/login")}
                  >
                    <IconSave size={16} />
                    Save &amp; exit
                  </button>
                )}
              </div>
              <SaveIndicator state={saveState} />
              <button
                className={styles.primary}
                type="button"
                onClick={() => void continueSetup()}
                disabled={saveState === "saving" || creating}
              >
                {step === "review"
                  ? creating
                    ? "Creating your workspace…"
                    : "Create pharmacy workspace"
                  : "Continue"}
                {step !== "review" ? (
                  <IconChevronRight size={17} />
                ) : (
                  <IconHome size={16} />
                )}
              </button>
            </div>
          </div>
          <ContextPanel step={step} draft={draft} />
        </section>
      </div>
    </main>
  );
}

function PharmacyForm({
  draft,
  update,
  patch,
}: {
  draft: OnboardingDraft;
  update: Update;
  patch: Patch;
}) {
  function changeCountry(value: string) {
    const defaults = countryDefaults(value);
    patch({
      country: value,
      currency: defaults.currency,
      timezone: defaults.timezone,
      businessPhoneCountryCode: defaults.phoneCode,
      branchCountry: value,
      branchTimezone: defaults.timezone,
      branchPhoneCountryCode: defaults.phoneCode,
    });
  }
  return (
    <>
      <h1>Tell us about your pharmacy</h1>
      <p className={styles.lead}>
        A home for your business, branches and team.
      </p>
      <div className={styles.divider} />
      <div className={styles.logoRow}>
        <ImageUpload
          value={draft.businessLogoUrl}
          endpoint="/onboarding/logo"
          size="compact"
          onChange={(url) => update("businessLogoUrl", url)}
          onRemove={removeOnboardingLogo}
        />
        <div className={styles.logoCopy}>
          <b>
            Business logo <small>(optional)</small>
          </b>
          <span>Used on receipts, invoices and your workspace.</span>
          <small>JPEG, PNG or WebP · maximum 2 MB</small>
        </div>
      </div>
      <div className={styles.form}>
        <Field
          label="Business name"
          value={draft.businessName}
          onChange={(value) => update("businessName", value)}
          hint="Use the name your team and customers will recognize."
          required
        />
        <Field
          label="Legal name"
          value={draft.legalName}
          onChange={(value) => update("legalName", value)}
          hint="Optional. Use the registered company name if different."
        />
        <div className={styles.grid2}>
          <SelectField
            label="Country"
            value={draft.country ?? "LK"}
            onChange={changeCountry}
            options={COUNTRY_OPTIONS}
            required
          />
          <SelectField
            label="Currency"
            value={draft.currency ?? "LKR"}
            onChange={(value) => update("currency", value)}
            options={CURRENCY_OPTIONS}
            required
          />
        </div>
        <SelectField
          label="Time zone"
          value={draft.timezone ?? "Asia/Colombo"}
          onChange={(value) => update("timezone", value)}
          options={TIMEZONE_OPTIONS}
          hint="Used for sales dates, shifts and reports."
          required
        />
        <div className={styles.grid2}>
          <Field
            label="Business email"
            type="email"
            value={draft.businessEmail}
            onChange={(value) => update("businessEmail", value)}
          />
          <PhoneField
            label="Business phone"
            code={draft.businessPhoneCountryCode ?? "+94"}
            number={draft.businessPhone}
            onCodeChange={(value) => update("businessPhoneCountryCode", value)}
            onNumberChange={(value) => update("businessPhone", value)}
          />
        </div>
        <Info>These details remain editable later in Settings.</Info>
      </div>
    </>
  );
}

function BranchForm({
  draft,
  update,
  patch,
}: {
  draft: OnboardingDraft;
  update: Update;
  patch: Patch;
}) {
  const branchCountry = draft.branchCountry ?? draft.country ?? "LK";
  const districtOptions = useMemo(
    () => districtsForProvince(draft.province),
    [draft.province],
  );
  function changeProvince(value: string) {
    const stillValid = districtsForProvince(value).some(
      (option) => option.value === draft.district,
    );
    patch({
      province: value,
      district: stillValid ? draft.district : undefined,
    });
  }
  function changeCountry(value: string) {
    const defaults = countryDefaults(value);
    patch({
      branchCountry: value,
      branchTimezone: defaults.timezone,
      branchPhoneCountryCode: defaults.phoneCode,
      province: undefined,
      district: undefined,
    });
  }
  return (
    <>
      <h1>Create your first branch</h1>
      <p className={styles.lead}>
        Set up the location where your team will work.
      </p>
      <div className={styles.divider} />
      <div className={styles.form}>
        <div className={styles.grid2}>
          <Field
            label="Branch name"
            value={draft.branchName}
            onChange={(value) => update("branchName", value)}
            required
          />
          <Field
            label="Branch code"
            value={draft.branchCode}
            onChange={(value) => update("branchCode", value.toUpperCase())}
            placeholder="MTL-01"
            hint="Suggested and editable."
          />
        </div>
        <Field
          label="Operating address"
          value={draft.addressLine1}
          onChange={(value) => update("addressLine1", value)}
          required
        />
        <div className={styles.grid2}>
          <Field
            label="City"
            value={draft.city}
            onChange={(value) => update("city", value)}
          />
          <Field
            label="Postal code"
            value={draft.postalCode}
            onChange={(value) => update("postalCode", value)}
          />
        </div>
        <div className={styles.grid2}>
          <SelectField
            label="Country"
            value={branchCountry}
            onChange={changeCountry}
            options={COUNTRY_OPTIONS}
          />
          {branchCountry === "LK" ? (
            <SelectField
              label="Province / region"
              value={draft.province ?? ""}
              onChange={changeProvince}
              options={[
                { value: "", label: "Select a province" },
                ...PROVINCE_OPTIONS,
              ]}
            />
          ) : (
            <Field
              label="State / region"
              value={draft.province}
              onChange={(value) => update("province", value)}
            />
          )}
        </div>
        {branchCountry === "LK" ? (
          <SelectField
            label="District"
            value={draft.district ?? ""}
            onChange={(value) => update("district", value)}
            options={[
              {
                value: "",
                label: draft.province
                  ? "Select a district"
                  : "Select a province first",
              },
              ...districtOptions,
            ]}
            disabled={!draft.province}
          />
        ) : null}
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={draft.useBusinessPhone ?? true}
            onChange={(event) =>
              update("useBusinessPhone", event.target.checked)
            }
          />
          <span>
            <b>Use business contact details</b>
            <small>
              The branch will use the phone entered for your pharmacy.
            </small>
          </span>
        </label>
        {draft.useBusinessPhone === false ? (
          <PhoneField
            label="Branch phone"
            code={
              draft.branchPhoneCountryCode ??
              countryDefaults(branchCountry).phoneCode
            }
            number={draft.branchPhone}
            onCodeChange={(value) => update("branchPhoneCountryCode", value)}
            onNumberChange={(value) => update("branchPhone", value)}
          />
        ) : null}
        <div className={styles.inheritedField}>
          <SelectField
            label="Branch time zone"
            value={draft.branchTimezone ?? draft.timezone ?? "Asia/Colombo"}
            onChange={(value) => update("branchTimezone", value)}
            options={TIMEZONE_OPTIONS}
          />
          <span>Inherited by default</span>
        </div>
        <Info>More locations can be added anytime from Settings.</Info>
      </div>
    </>
  );
}

function PreferencesForm({
  draft,
  update,
}: {
  draft: OnboardingDraft;
  update: Update;
}) {
  const payments = draft.paymentMethods ?? ["cash", "card"];
  // Medicines is always on — it is the one department every pharmacy has — so it shows
  // ticked and locked rather than as a choice someone could get wrong.
  const sells = draft.sellsDepartments ?? [];
  return (
    <>
      <h1>Make it work your way</h1>
      <p className={styles.lead}>
        Choose a few starting preferences. Fine-tune the rest in Settings.
      </p>
      <div className={styles.divider} />
      <div className={styles.form}>
        <fieldset className={styles.choiceFieldset}>
          <legend>How are you getting started?</legend>
          <div className={styles.choiceRow}>
            {(["fresh", "migrating"] as const).map((mode) => (
              <button
                type="button"
                key={mode}
                className={`${styles.choice} ${draft.migrationMode === mode ? styles.selected : ""}`}
                onClick={() => update("migrationMode", mode)}
              >
                <span className={styles.radio}>
                  {draft.migrationMode === mode ? <i /> : null}
                </span>
                <IconPackage size={29} />
                <b>
                  {mode === "fresh"
                    ? "Opening a new pharmacy"
                    : "Moving from another system"}
                </b>
                <small>
                  {mode === "fresh"
                    ? "Build your catalog and add opening stock."
                    : "Bring your products and inventory with you."}
                </small>
              </button>
            ))}
          </div>
        </fieldset>
        {draft.migrationMode === "migrating" ? (
          <Info>
            Your first setup step will be the product importer — bring your list
            and opening stock across in one file.
          </Info>
        ) : null}

        <fieldset className={styles.paymentFieldset}>
          <legend>What does your pharmacy sell?</legend>
          <div className={styles.sellsRow}>
            {SELLS_DEPARTMENTS.map((label) => {
              const locked = label === "Medicines";
              const checked = locked || sells.includes(label);
              return (
                <label
                  key={label}
                  className={`${styles.payment}${locked ? ` ${styles.sellsLocked}` : ""}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={locked}
                    onChange={(event) =>
                      update(
                        "sellsDepartments",
                        event.target.checked
                          ? [...sells, label]
                          : sells.filter((item) => item !== label),
                      )
                    }
                  />
                  <span>{label}</span>
                </label>
              );
            })}
          </div>
          <small>
            Turns on the matching product departments so you can file products
            under them from day one. You can change this later in Settings →
            Catalog → Categories.
          </small>
        </fieldset>
        <div className={styles.sectionTitle}>Receipt details</div>
        <div className={styles.grid2}>
          <Field
            label="Receipt display name"
            value={draft.receiptDisplayName ?? draft.businessName}
            onChange={(value) => update("receiptDisplayName", value)}
            hint="Shown on customer receipts."
          />
          <SelectField
            label="Date format"
            value={draft.dateFormat ?? "DD/MM/YYYY"}
            onChange={(value) => update("dateFormat", value)}
            options={DATE_FORMAT_OPTIONS}
          />
        </div>
        <fieldset className={styles.paymentFieldset}>
          <legend>Initial payment methods</legend>
          <div className={styles.paymentRow}>
            {[
              { value: "cash", label: "Cash" },
              { value: "card", label: "Card" },
              { value: "mobile_wallet", label: "Mobile wallet" },
              { value: "credit", label: "Customer credit" },
            ].map((method) => (
              <label key={method.value} className={styles.payment}>
                <input
                  type="checkbox"
                  checked={payments.includes(method.value)}
                  onChange={(event) =>
                    update(
                      "paymentMethods",
                      event.target.checked
                        ? [...payments, method.value]
                        : payments.filter((item) => item !== method.value),
                    )
                  }
                />
                <span>{method.label}</span>
              </label>
            ))}
          </div>
          <small>
            Enable only methods your first branch accepts. Integrations are
            configured separately.
          </small>
        </fieldset>
      </div>
    </>
  );
}

function Review({
  draft,
  owner,
  goTo,
}: {
  draft: OnboardingDraft;
  owner: VerifiedOwnerSession | null;
  goTo: (path: string) => Promise<void>;
}) {
  return (
    <>
      <h1>Review your workspace setup</h1>
      <p className={styles.lead}>
        Everything needed for your first workspace is grouped below.
      </p>
      <div className={styles.reviewStatus}>
        <span>
          <IconCheckCircle size={20} />
        </span>
        <div>
          <b>Your setup details are complete</b>
          <small>Review each section, then confirm your saved setup.</small>
        </div>
        <strong>4 sections ready</strong>
      </div>
      <div className={styles.reviewList}>
        <ReviewSection
          icon={<IconHome size={23} />}
          title="Pharmacy business"
          edit={() => void goTo("/onboarding/pharmacy")}
          rows={[
            ["Business name", draft.businessName],
            ["Country", optionLabel(COUNTRY_OPTIONS, draft.country)],
            ["Currency", draft.currency],
            ["Time zone", optionLabel(TIMEZONE_OPTIONS, draft.timezone)],
          ]}
        />
        <ReviewSection
          icon={<IconMapPin size={23} />}
          title="First branch"
          edit={() => void goTo("/onboarding/branch")}
          rows={[
            [
              "Branch",
              [draft.branchName, draft.branchCode].filter(Boolean).join(" · "),
            ],
            [
              "Address",
              [draft.addressLine1, draft.city, draft.postalCode]
                .filter(Boolean)
                .join(", "),
            ],
            [
              "Region",
              [
                draft.district,
                draft.province,
                optionLabel(COUNTRY_OPTIONS, draft.branchCountry),
              ]
                .filter(Boolean)
                .join(", "),
            ],
          ]}
        />
        <ReviewSection
          icon={<IconUser size={23} />}
          title="Owner account"
          rows={[
            [
              "Owner",
              owner ? `${owner.firstName} ${owner.lastName}` : undefined,
            ],
            ["Email", owner?.email],
            ["Status", "Email verified"],
          ]}
        />
        <ReviewSection
          icon={<IconSettings size={23} />}
          title="Starting preferences"
          edit={() => void goTo("/onboarding/preferences")}
          rows={[
            [
              "Starting mode",
              draft.migrationMode === "migrating"
                ? "Moving from another system"
                : "Opening a new pharmacy",
            ],
            [
              "Payment methods",
              (draft.paymentMethods ?? []).map(labelPayment).join(", "),
            ],
            ["Receipt", draft.receiptDisplayName ?? draft.businessName],
          ]}
        />
      </div>
      <Info>
        Your confirmed setup stays safely saved and can still be updated before
        the workspace is created.
      </Info>
    </>
  );
}

function ContextPanel({ step, draft }: { step: Step; draft: OnboardingDraft }) {
  if (step === "pharmacy")
    return (
      <aside className={styles.contextCard}>
        <p className={styles.contextLabel}>ONE BUSINESS. ROOM TO GROW.</p>
        <div className={styles.businessDiagram}>
          <span>
            <IconHome size={34} />
          </span>
          <b>{draft.businessName || "Your pharmacy"}</b>
          <i />
          <div>
            <span className={styles.branchNode}>
              <IconHome size={24} />
              <small>Your first branch</small>
            </span>
            <span>
              ＋<small>Add more later</small>
            </span>
            <span>
              ＋<small>Add more later</small>
            </span>
          </div>
        </div>
        <ul className={styles.benefits}>
          <li>
            <IconCheckCircle size={17} />
            One shared product catalog
          </li>
          <li>
            <IconCheckCircle size={17} />
            Separate stock for each branch
          </li>
          <li>
            <IconCheckCircle size={17} />
            Access based on team roles
          </li>
        </ul>
        <Info>Only your first branch is needed to get started.</Info>
      </aside>
    );
  if (step === "branch")
    return (
      <aside className={styles.contextCard}>
        <p className={styles.contextLabel}>YOUR FIRST LOCATION</p>
        <div className={styles.branchPreview}>
          <IconHome size={70} />
          <h2>{draft.branchName || "Your first branch"}</h2>
          <p>{draft.businessName || "Your pharmacy"}</p>
          <span>{draft.addressLine1 || "Operating address"}</span>
          <span>
            {[draft.city, draft.district, draft.postalCode]
              .filter(Boolean)
              .join(" · ") || "City and district"}
          </span>
          {draft.branchCode ? <b>{draft.branchCode}</b> : null}
        </div>
        <dl>
          <div>
            <dt>Currency</dt>
            <dd>{draft.currency ?? "LKR"}</dd>
          </div>
          <div>
            <dt>Time zone</dt>
            <dd>{draft.branchTimezone ?? draft.timezone ?? "Asia/Colombo"}</dd>
          </div>
        </dl>
        <Info>
          Inventory and sales will be tracked separately for this branch.
        </Info>
      </aside>
    );
  if (step === "preferences")
    return (
      <aside className={styles.contextCard}>
        <p className={styles.contextLabel}>RECEIPT PREVIEW</p>
        <div className={styles.receipt}>
          <IconReceipt size={24} />
          <h3>
            {draft.receiptDisplayName || draft.businessName || "Your pharmacy"}
          </h3>
          <p>{draft.branchName || "Your first branch"}</p>
          <span>{draft.addressLine1 || "Branch address"}</span>
          <i />
          <b>SAMPLE RECEIPT</b>
          <small>Your purchased items will appear here</small>
          <p>Currency: {draft.currency ?? "LKR"}</p>
          <p>Date: {draft.dateFormat ?? "DD/MM/YYYY"}</p>
          <strong>Thank you for visiting.</strong>
        </div>
        <p className={styles.previewNote}>
          Preview only. Receipt layout, tax and printer settings are reviewed
          before selling.
        </p>
      </aside>
    );
  return (
    <aside className={styles.contextCard}>
      <p className={styles.contextLabel}>WHAT HAPPENS NEXT?</p>
      <div className={styles.nextSteps}>
        <div>
          <span>1</span>
          <IconShield size={25} />
          <p>
            <b>Confirm your setup</b>
            <small>Your reviewed details remain secure and resumable.</small>
          </p>
        </div>
        <div>
          <span>2</span>
          <IconHome size={25} />
          <p>
            <b>Create the workspace</b>
            <small>
              Your pharmacy, branch and owner access are created together.
            </small>
          </p>
        </div>
        <div>
          <span>3</span>
          <IconPackage size={25} />
          <p>
            <b>Prepare products and stock</b>
            <small>Continue with the readiness checklist.</small>
          </p>
        </div>
      </div>
      <Info>
        Workspace setup is the beginning. Real sales stay unavailable until
        required operational setup is complete.
      </Info>
    </aside>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  required = false,
  placeholder,
  hint,
}: {
  label: string;
  value?: string;
  onChange: (value: string) => void;
  type?: string;
  required?: boolean;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <label className={styles.field}>
      {label}
      {required ? <em>*</em> : null}
      <input
        type={type}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value)}
        required={required}
        placeholder={placeholder}
      />
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

function PhoneField({
  label,
  code,
  number,
  onCodeChange,
  onNumberChange,
}: {
  label: string;
  code: string;
  number?: string;
  onCodeChange: (value: string) => void;
  onNumberChange: (value: string) => void;
}) {
  return (
    <div className={styles.field}>
      <span className={styles.fieldName}>{label}</span>
      <span className={styles.phoneControl}>
        <SelectField
          label={`${label} country code`}
          ariaLabel={`${label} country code`}
          hideLabel
          value={code}
          onChange={onCodeChange}
          options={PHONE_CODE_OPTIONS}
          className={styles.phoneCode}
          wideMenu
        />
        <input
          aria-label={label}
          inputMode="tel"
          value={number ?? ""}
          onChange={(event) => onNumberChange(event.target.value)}
          placeholder="Phone number"
        />
      </span>
    </div>
  );
}

function Info({ children }: { children: ReactNode }) {
  return (
    <div className={styles.info}>
      <IconInfo size={18} />
      <span>{children}</span>
    </div>
  );
}

function SaveIndicator({ state }: { state: SaveState }) {
  const label =
    state === "saving"
      ? "Saving…"
      : state === "unsaved"
        ? "Changes pending"
        : state === "error"
          ? "Couldn’t save"
          : "Draft saved";
  return (
    <span className={`${styles.saveState} ${styles[state]}`}>
      {state === "saved" ? (
        <IconCheckCircle size={16} />
      ) : state === "saving" ? (
        <IconUpload size={16} />
      ) : state === "error" ? (
        <IconInfo size={16} />
      ) : (
        <IconCloud size={16} />
      )}
      {label}
    </span>
  );
}

function ReviewSection({
  icon,
  title,
  rows,
  edit,
}: {
  icon: ReactNode;
  title: string;
  rows: Array<[string, string | undefined]>;
  edit?: () => void;
}) {
  return (
    <section>
      <div className={styles.reviewIcon}>{icon}</div>
      <div className={styles.reviewContent}>
        <header>
          <h2>{title}</h2>
          {edit ? (
            <button type="button" onClick={edit}>
              <IconEdit size={15} />
              Edit
            </button>
          ) : (
            <span className={styles.reviewVerified}>
              <IconCheckCircle size={15} /> Verified
            </span>
          )}
        </header>
        <dl>
          {rows
            .filter(([, value]) => value)
            .map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
        </dl>
      </div>
    </section>
  );
}

function labelPayment(value: string): string {
  return (
    {
      cash: "Cash",
      card: "Card",
      mobile_wallet: "Mobile wallet",
      credit: "Customer credit",
    }[value] ?? value
  );
}
