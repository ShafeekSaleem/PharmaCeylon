"use client";

import Link from "next/link";
import { FormEvent, useId, useState } from "react";
import { Alert } from "@/components/alert";
import { IconCheckCircle, IconLock, IconMail } from "@/components/icons";
import { requestPasswordReset } from "@/lib/password-reset-client";
import css from "@/components/auth-card/auth-card.module.css";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function ForgotPasswordPage() {
  const emailId = useId();
  const [email, setEmail] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = email.trim();
    if (!EMAIL_RE.test(trimmed)) {
      setFieldError("Enter a valid email address");
      return;
    }
    setFieldError(null);
    setError(null);
    setLoading(true);
    try {
      await requestPasswordReset(trimmed);
      setSent(true);
    } catch (cause) {
      // Only reachable for transport failures or the throttle — the API returns
      // the same success for known and unknown addresses.
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not send the reset email. Try again shortly.",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className={css.page}>
      <div className={css.card}>
        {sent ? (
          <>
            <div className={css.statusMark}>
              <IconCheckCircle size={20} />
            </div>
            <h1 className={css.title}>Check your email</h1>
            {/*
              Worded so it is true whether or not an account exists — saying "we
              sent you a link" for an unregistered address would confirm the
              address is not registered, which is the enumeration leak the API
              is careful to avoid.
            */}
            <p className={css.subtitle}>
              If <strong>{email.trim()}</strong> belongs to a PharmaCeylon
              account, a reset link is on its way. It works once and expires in
              30 minutes.
            </p>
            <Alert variant="info">
              No email after a few minutes? Check your spam folder, or ask an
              owner or manager at your pharmacy to confirm the address on your
              account.
            </Alert>
            <p className={css.footer}>
              <Link className={css.footerLink} href="/login">
                Back to sign in
              </Link>
            </p>
          </>
        ) : (
          <>
            <div className={css.mark}>
              <IconLock size={18} />
            </div>
            <h1 className={css.title}>Reset your password</h1>
            <p className={css.subtitle}>
              Enter the email you sign in with and we’ll send you a link to
              choose a new password.
            </p>

            <form
              className={`${css.form}${loading ? ` ${css.formLoading}` : ""}`}
              onSubmit={onSubmit}
              noValidate
            >
              <div className={css.fieldGroup}>
                <label htmlFor={emailId} className={css.fieldLabel}>
                  Email
                </label>
                <div className={css.fieldWrap}>
                  <span className={css.fieldIcon}>
                    <IconMail size={15} />
                  </span>
                  <input
                    id={emailId}
                    name="email"
                    type="email"
                    className={`${css.input}${fieldError ? ` ${css.inputError}` : ""}`}
                    placeholder="you@pharmacy.lk"
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      setFieldError(null);
                    }}
                    autoComplete="username"
                    autoFocus
                    required
                  />
                </div>
                {fieldError ? (
                  <span className={css.fieldError}>{fieldError}</span>
                ) : null}
              </div>

              {error ? (
                <div className={css.alertSlot}>
                  <Alert variant="error">{error}</Alert>
                </div>
              ) : null}

              <button type="submit" className={css.submit} disabled={loading}>
                {loading ? (
                  <>
                    <span className={css.spinner} />
                    Sending…
                  </>
                ) : (
                  "Send reset link"
                )}
              </button>
            </form>

            <p className={css.footer}>
              Remembered it?{" "}
              <Link className={css.footerLink} href="/login">
                Back to sign in
              </Link>
            </p>
          </>
        )}
      </div>
    </main>
  );
}
