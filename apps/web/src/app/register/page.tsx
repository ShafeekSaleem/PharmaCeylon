"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState, type ReactNode } from "react";
import { Alert } from "@/components/alert";
import {
  IconCheck,
  IconEye,
  IconEyeOff,
  IconFirstAid,
  IconShield,
} from "@/components/icons";
import { SelectField } from "@/components/ui/select-field";
import { PHONE_CODE_OPTIONS } from "@/lib/onboarding-options";
import { createOwnerRegistration } from "@/lib/owner-registration-client";
import styles from "./register.module.css";

type Fields = {
  firstName: string;
  lastName: string;
  email: string;
  phoneCountryCode: string;
  phone: string;
  password: string;
  confirmPassword: string;
  accepted: boolean;
};

const initialFields: Fields = {
  firstName: "",
  lastName: "",
  email: "",
  phoneCountryCode: "+94",
  phone: "",
  password: "",
  confirmPassword: "",
  accepted: false,
};

const journey = [
  [
    "Create your owner account",
    "Tell us who will own and manage the workspace.",
  ],
  ["Verify your email", "Enter the secure code we send to your inbox."],
  [
    "Set up your pharmacy",
    "Add the business, first branch and starting preferences.",
  ],
];

export default function RegisterPage() {
  const router = useRouter();
  const [fields, setFields] = useState(initialFields);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function update<K extends keyof Fields>(key: K, value: Fields[K]) {
    setFields((current) => ({ ...current, [key]: value }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (!fields.firstName.trim() || !fields.lastName.trim()) {
      setError("Enter your first and last name.");
      return;
    }
    if (
      fields.password.length < 8 ||
      !/\d/.test(fields.password) ||
      !/[^A-Za-z0-9]/.test(fields.password)
    ) {
      setError("Use at least 8 characters, including a number and a symbol.");
      return;
    }
    if (fields.password !== fields.confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    if (!fields.accepted) {
      setError("Accept the Terms of Service and Privacy Policy to continue.");
      return;
    }

    setSubmitting(true);
    try {
      const result = await createOwnerRegistration({
        firstName: fields.firstName,
        lastName: fields.lastName,
        email: fields.email,
        phone: fields.phone.trim()
          ? `${fields.phoneCountryCode} ${fields.phone.trim()}`
          : undefined,
        password: fields.password,
      });
      sessionStorage.setItem("pc_pending_owner_email", result.email);
      router.push("/verify-email");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Account creation failed.",
      );
      setSubmitting(false);
    }
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link href="/login" className={styles.brand}>
          <span className={styles.brandMark}>
            <IconFirstAid size={19} />
          </span>
          PharmaCeylon
        </Link>
        <span>
          Already have an account? <Link href="/login">Sign in</Link>
        </span>
      </header>

      <section className={styles.card}>
        <div className={styles.formPanel}>
          <div className={styles.stage}>
            <span>1</span>
            <b>Account</b>
            <i />
            <span>2</span>
            <b>Verify</b>
            <i />
            <span>3</span>
            <b>Workspace</b>
          </div>
          <p className={styles.eyebrow}>STEP 1 OF 3 · OWNER ACCOUNT</p>
          <h1>Start with your owner account</h1>
          <p className={styles.lead}>
            Create your secure identity first. Your pharmacy details come next.
          </p>

          <form onSubmit={submit} className={styles.form} noValidate>
            <div className={styles.twoColumns}>
              <label>
                First name
                <input
                  autoComplete="given-name"
                  value={fields.firstName}
                  onChange={(event) => update("firstName", event.target.value)}
                  required
                />
              </label>
              <label>
                Last name
                <input
                  autoComplete="family-name"
                  value={fields.lastName}
                  onChange={(event) => update("lastName", event.target.value)}
                  required
                />
              </label>
            </div>
            <label>
              Work email
              <input
                type="email"
                autoComplete="email"
                value={fields.email}
                onChange={(event) => update("email", event.target.value)}
                required
              />
            </label>
            <div className={styles.phoneField}>
              <span className={styles.fieldLabel}>
                Phone number <span className={styles.optional}>(optional)</span>
              </span>
              <div className={styles.phoneRow}>
                <SelectField
                  label="Phone country code"
                  ariaLabel="Phone country code"
                  hideLabel
                  value={fields.phoneCountryCode}
                  onChange={(value) => update("phoneCountryCode", value)}
                  options={PHONE_CODE_OPTIONS}
                  className={styles.phoneCode}
                />
                <input
                  aria-label="Phone number"
                  inputMode="tel"
                  autoComplete="tel-national"
                  value={fields.phone}
                  onChange={(event) => update("phone", event.target.value)}
                  placeholder="Phone number"
                />
              </div>
            </div>
            <div className={styles.twoColumns}>
              <PasswordField
                label="Password"
                value={fields.password}
                visible={showPassword}
                onVisibleChange={setShowPassword}
                onChange={(value) => update("password", value)}
              />
              <PasswordField
                label="Confirm password"
                value={fields.confirmPassword}
                visible={showConfirmation}
                onVisibleChange={setShowConfirmation}
                onChange={(value) => update("confirmPassword", value)}
              />
            </div>
            <div className={styles.passwordRules}>
              <Rule passed={fields.password.length >= 8}>8 characters</Rule>
              <Rule passed={/\d/.test(fields.password)}>One number</Rule>
              <Rule passed={/[^A-Za-z0-9]/.test(fields.password)}>
                One symbol
              </Rule>
            </div>
            <label className={styles.terms}>
              <input
                type="checkbox"
                checked={fields.accepted}
                onChange={(event) => update("accepted", event.target.checked)}
              />
              <span>
                I agree to the <a href="#">Terms of Service</a> and{" "}
                <a href="#">Privacy Policy</a>.
              </span>
            </label>
            {error ? <Alert variant="error">{error}</Alert> : null}
            <button className={styles.submit} disabled={submitting}>
              {submitting ? "Creating account…" : "Create account and continue"}
            </button>
            <p className={styles.security}>
              <IconShield size={15} /> Your identity stays separate from
              pharmacy data until workspace creation.
            </p>
          </form>
        </div>

        <aside className={styles.journeyPanel}>
          <p className={styles.panelEyebrow}>YOUR SETUP JOURNEY</p>
          <h2>Know exactly where you are.</h2>
          <p className={styles.panelLead}>
            A guided path from account creation to a pharmacy ready for setup.
          </p>
          <ol>
            {journey.map(([title, description], index) => (
              <li
                key={title}
                className={index === 0 ? styles.activeJourney : ""}
              >
                <span>{index + 1}</span>
                <div>
                  <b>{title}</b>
                  <small>{description}</small>
                </div>
              </li>
            ))}
          </ol>
          <div className={styles.timeNote}>
            <b>About 4 minutes</b>
            <span>Your progress is saved as you go.</span>
          </div>
        </aside>
      </section>
    </main>
  );
}

function PasswordField({
  label,
  value,
  visible,
  onVisibleChange,
  onChange,
}: {
  label: string;
  value: string;
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      {label}
      <span className={styles.passwordControl}>
        <input
          type={visible ? "text" : "password"}
          autoComplete="new-password"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          required
        />
        <button
          type="button"
          aria-label={
            visible
              ? `Hide ${label.toLowerCase()}`
              : `Show ${label.toLowerCase()}`
          }
          aria-pressed={visible}
          onClick={() => onVisibleChange(!visible)}
        >
          {visible ? <IconEyeOff size={18} /> : <IconEye size={18} />}
        </button>
      </span>
    </label>
  );
}

function Rule({ passed, children }: { passed: boolean; children: ReactNode }) {
  return (
    <span className={passed ? styles.rulePassed : ""}>
      <IconCheck size={13} />
      {children}
    </span>
  );
}
