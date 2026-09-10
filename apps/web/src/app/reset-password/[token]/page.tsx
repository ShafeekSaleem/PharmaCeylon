"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { FormEvent, useEffect, useId, useState } from "react";
import { Alert } from "@/components/alert";
import {
  IconAlertTriangle,
  IconCheckCircle,
  IconEye,
  IconEyeOff,
  IconLock,
} from "@/components/icons";
import {
  confirmPasswordReset,
  inspectPasswordResetToken,
  type PasswordResetTokenDetails,
} from "@/lib/password-reset-client";
import css from "@/components/auth-card/auth-card.module.css";

export default function ResetPasswordPage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const passwordId = useId();
  const confirmId = useId();

  const [details, setDetails] = useState<PasswordResetTokenDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [linkError, setLinkError] = useState<string | null>(null);

  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  // Validate the link before rendering the form, so an expired one explains
  // itself instead of failing after the person has typed a new password twice.
  useEffect(() => {
    if (!token) return;
    void inspectPasswordResetToken(token)
      .then(setDetails)
      .catch((cause) =>
        setLinkError(
          cause instanceof Error
            ? cause.message
            : "This reset link is invalid or has expired.",
        ),
      )
      .finally(() => setLoading(false));
  }, [token]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (password !== confirmation) {
      setError("Passwords do not match.");
      return;
    }
    // Mirrors the server floor; the tenant's configured minimum is applied
    // there and comes back as a message if it is stricter than this.
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (!/\d/.test(password) && !/[^A-Za-z0-9]/.test(password)) {
      setError("Include at least one number or symbol.");
      return;
    }
    setSubmitting(true);
    try {
      await confirmPasswordReset(token, password);
      setDone(true);
      // Every session was revoked server-side, so signing in again is the only
      // way forward — send them there rather than leaving a dead end.
      setTimeout(() => router.replace("/login?reset=success"), 2200);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not reset your password",
      );
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className={css.loadingPage}>
        <div className={css.loadingSpinner} />
      </div>
    );
  }

  return (
    <main className={css.page}>
      <div className={css.card}>
        {linkError ? (
          <>
            <div className={`${css.statusMark} ${css.statusMarkWarn}`}>
              <IconAlertTriangle size={20} />
            </div>
            <h1 className={css.title}>Link no longer valid</h1>
            <p className={css.subtitle}>{linkError}</p>
            <p className={css.footer}>
              <Link className={css.footerLink} href="/forgot-password">
                Request a new link
              </Link>
            </p>
          </>
        ) : done ? (
          <>
            <div className={css.statusMark}>
              <IconCheckCircle size={20} />
            </div>
            <h1 className={css.title}>Password updated</h1>
            <p className={css.subtitle}>
              You’ve been signed out everywhere for security. Taking you to sign
              in…
            </p>
            <p className={css.footer}>
              <Link className={css.footerLink} href="/login">
                Sign in now
              </Link>
            </p>
          </>
        ) : (
          <>
            <div className={css.mark}>
              <IconLock size={18} />
            </div>
            <h1 className={css.title}>Choose a new password</h1>
            <p className={css.subtitle}>
              Setting a new password for <strong>{details?.email}</strong>.
            </p>

            <form
              className={`${css.form}${submitting ? ` ${css.formLoading}` : ""}`}
              onSubmit={onSubmit}
              noValidate
            >
              <div className={css.fieldGroup}>
                <label htmlFor={passwordId} className={css.fieldLabel}>
                  New password
                </label>
                <div className={css.fieldWrap}>
                  <span className={css.fieldIcon}>
                    <IconLock size={15} />
                  </span>
                  <input
                    id={passwordId}
                    name="new-password"
                    type={showPassword ? "text" : "password"}
                    className={`${css.input} ${css.hasToggle}`}
                    placeholder="At least 8 characters"
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      setError(null);
                    }}
                    autoComplete="new-password"
                    autoFocus
                    required
                    minLength={8}
                  />
                  <button
                    type="button"
                    className={css.togglePw}
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? (
                      <IconEyeOff size={17} />
                    ) : (
                      <IconEye size={17} />
                    )}
                  </button>
                </div>
              </div>

              <div className={css.fieldGroup}>
                <label htmlFor={confirmId} className={css.fieldLabel}>
                  Confirm password
                </label>
                <div className={css.fieldWrap}>
                  <span className={css.fieldIcon}>
                    <IconLock size={15} />
                  </span>
                  <input
                    id={confirmId}
                    name="confirm-password"
                    type={showPassword ? "text" : "password"}
                    className={css.input}
                    placeholder="Repeat your new password"
                    value={confirmation}
                    onChange={(e) => {
                      setConfirmation(e.target.value);
                      setError(null);
                    }}
                    autoComplete="new-password"
                    required
                    minLength={8}
                  />
                </div>
              </div>

              {error ? (
                <div className={css.alertSlot}>
                  <Alert variant="error">{error}</Alert>
                </div>
              ) : null}

              <button type="submit" className={css.submit} disabled={submitting}>
                {submitting ? (
                  <>
                    <span className={css.spinner} />
                    Updating…
                  </>
                ) : (
                  "Update password"
                )}
              </button>
            </form>

            <p className={css.footer}>
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
