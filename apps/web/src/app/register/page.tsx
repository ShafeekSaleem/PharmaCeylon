"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { Alert } from "@/components/alert";
import { createOwnerRegistration } from "@/lib/owner-registration-client";
import styles from "./register.module.css";

type Fields = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  password: string;
  confirmPassword: string;
  accepted: boolean;
};

const initialFields: Fields = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  password: "",
  confirmPassword: "",
  accepted: false,
};

export default function RegisterPage() {
  const router = useRouter();
  const [fields, setFields] = useState(initialFields);
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
    if (fields.password.length < 8 || !/\d/.test(fields.password) || !/[^A-Za-z0-9]/.test(fields.password)) {
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
        phone: fields.phone.trim() ? `+94 ${fields.phone.trim()}` : undefined,
        password: fields.password,
      });
      sessionStorage.setItem("pc_pending_owner_email", result.email);
      router.push("/verify-email");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Account creation failed.");
      setSubmitting(false);
    }
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link href="/login" className={styles.logo}>PharmaCeylon</Link>
        <span>Already have an account? <Link href="/login">Sign in</Link></span>
      </header>

      <section className={styles.card}>
        <div className={styles.formPanel}>
          <p className={styles.eyebrow}>CREATE YOUR ACCOUNT</p>
          <h1>Start with your owner account</h1>
          <p className={styles.lead}>Next, we’ll help you create your pharmacy workspace.</p>

          <form onSubmit={submit} className={styles.form} noValidate>
            <div className={styles.twoColumns}>
              <label>First name
                <input autoComplete="given-name" value={fields.firstName} onChange={(e) => update("firstName", e.target.value)} required />
              </label>
              <label>Last name
                <input autoComplete="family-name" value={fields.lastName} onChange={(e) => update("lastName", e.target.value)} required />
              </label>
            </div>
            <label>Work email
              <input type="email" autoComplete="email" value={fields.email} onChange={(e) => update("email", e.target.value)} required />
            </label>
            <label>Phone number <span className={styles.optional}>(optional)</span>
              <div className={styles.phoneRow}><span>+94</span><input inputMode="tel" autoComplete="tel" value={fields.phone} onChange={(e) => update("phone", e.target.value)} placeholder="Phone number" /></div>
            </label>
            <div className={styles.twoColumns}>
              <label>Password
                <input type="password" autoComplete="new-password" value={fields.password} onChange={(e) => update("password", e.target.value)} required />
              </label>
              <label>Confirm password
                <input type="password" autoComplete="new-password" value={fields.confirmPassword} onChange={(e) => update("confirmPassword", e.target.value)} required />
              </label>
            </div>
            <p className={styles.hint}>At least 8 characters with a number and symbol.</p>
            <label className={styles.terms}>
              <input type="checkbox" checked={fields.accepted} onChange={(e) => update("accepted", e.target.checked)} />
              <span>I agree to the Terms of Service and Privacy Policy.</span>
            </label>
            {error ? <Alert variant="error">{error}</Alert> : null}
            <button className={styles.submit} disabled={submitting}>
              {submitting ? "Creating account…" : "Create account"}
            </button>
            <p className={styles.security}>Your account is kept separate from your pharmacy data until workspace creation.</p>
          </form>
        </div>

        <aside className={styles.stepsPanel}>
          <h2>Account first.<br />Pharmacy next.</h2>
          <ol>
            <li><b>Create and verify your account</b><span>Set up your owner identity and confirm your email.</span></li>
            <li><b>Set up your pharmacy and first branch</b><span>Add the essential details for your business and location.</span></li>
            <li><b>Prepare products, stock and checkout</b><span>Complete the operational setup before your first sale.</span></li>
          </ol>
          <p>Usually takes just a few minutes.</p>
        </aside>
      </section>
    </main>
  );
}
