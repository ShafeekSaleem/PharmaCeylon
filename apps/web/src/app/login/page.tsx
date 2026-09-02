"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useId, useRef, useState } from "react";
import { useAuth } from "@/lib/use-auth";
import { Alert } from "@/components/alert";
import { IconMail, IconLock, IconEye, IconEyeOff } from "@/components/icons";
import styles from "./login.module.css";

const EMAIL_STORAGE_KEY = "pc_last_email";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function TempBrandMark() {
  return (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" aria-hidden>
      <rect x="8" y="12" width="28" height="22" rx="3" stroke="white" strokeWidth="2.5" />
      <path d="M16 12V9a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v3" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M24 22v8M20 26h8" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

function getSavedEmail(): string {
  try {
    return localStorage.getItem(EMAIL_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className={styles.loadingPage}>
          <div className={styles.loadingSpinner} />
        </div>
      }
    >
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectTo = searchParams.get("redirect") || "/dashboard";
  const emailId = useId();
  const passwordId = useId();
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const { login, isAuthenticated, ready } = useAuth();

  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ email: string | null; password: string | null }>({
    email: null,
    password: null,
  });

  useEffect(() => {
    if (ready && isAuthenticated) {
      router.replace(redirectTo);
    }
  }, [ready, isAuthenticated, router, redirectTo]);

  useEffect(() => {
    if (ready && emailRef.current && !emailRef.current.value) {
      emailRef.current.value = getSavedEmail();
    }
  }, [ready]);

  const readFields = useCallback(() => {
    const email = (emailRef.current?.value ?? "").trim();
    const password = passwordRef.current?.value ?? "";
    return { email, password };
  }, []);

  function validate(): { email: string; password: string } | null {
    const { email, password } = readFields();
    const errs = {
      email: !email
        ? "Email cannot be empty."
        : !EMAIL_RE.test(email)
          ? "Please enter a valid email address."
          : null,
      password: !password ? "Password cannot be empty." : null,
    };
    setFieldErrors(errs);
    if (errs.email || errs.password) return null;
    return { email, password };
  }

  function clearFieldError(field: "email" | "password") {
    setFieldErrors((prev) => (prev[field] ? { ...prev, [field]: null } : prev));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const fields = validate();
    if (!fields) return;

    setError(null);
    setLoading(true);
    try {
      await login(fields);
      try { localStorage.setItem(EMAIL_STORAGE_KEY, fields.email); } catch {}
      setNavigating(true);
      router.push(redirectTo);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
      setLoading(false);
    }
  }

  if (!ready || navigating) {
    return (
      <div className={styles.loadingPage}>
        <div className={styles.loadingSpinner} />
      </div>
    );
  }

  return (
    <main className={styles.page}>
      <div className={styles.cardCenter}>
        <div className={styles.card}>
          <div className={styles.formColumn}>
            <h1 className={styles.title}>Welcome back</h1>
            <p className={styles.subtitle}>Sign in to continue to your pharmacy workspace.</p>
            <form
              className={`${styles.form}${loading ? ` ${styles.formLoading}` : ""}`}
              onSubmit={onSubmit}
              noValidate
            >
              <div className={styles.fieldGroup}>
                <label htmlFor={emailId} className={styles.fieldLabel}>
                  Email
                </label>
                <div className={styles.fieldWrap}>
                  <span className={styles.fieldIcon}><IconMail size={16} /></span>
                  <input
                    ref={emailRef}
                    id={emailId}
                    name="email"
                    type="email"
                    className={`${styles.input}${fieldErrors.email ? ` ${styles.inputError}` : ""}`}
                    placeholder="Email"
                    defaultValue=""
                    onChange={() => clearFieldError("email")}
                    autoComplete="username"
                    required
                  />
                </div>
                <p className={`${styles.fieldError}${fieldErrors.email ? "" : ` ${styles.fieldErrorHidden}`}`}>
                  {fieldErrors.email || "\u00A0"}
                </p>
              </div>

              <div className={styles.fieldGroup}>
                <label htmlFor={passwordId} className={styles.fieldLabel}>
                  Password
                </label>
                <div className={`${styles.fieldWrap} ${styles.passwordRow}`}>
                  <span className={styles.fieldIcon}><IconLock size={16} /></span>
                  <input
                    ref={passwordRef}
                    id={passwordId}
                    name="password"
                    type={showPassword ? "text" : "password"}
                    className={`${styles.input}${fieldErrors.password ? ` ${styles.inputError}` : ""}`}
                    placeholder="Password"
                    onChange={() => clearFieldError("password")}
                    autoComplete="current-password"
                    required
                    minLength={8}
                  />
                  <button
                    type="button"
                    className={styles.togglePw}
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? <IconEyeOff size={20} /> : <IconEye size={20} />}
                  </button>
                </div>
                <p className={`${styles.fieldError}${fieldErrors.password ? "" : ` ${styles.fieldErrorHidden}`}`}>
                  {fieldErrors.password || "\u00A0"}
                </p>
              </div>

              <div className={styles.errorSlot}>
                {error ? <Alert variant="error">{error}</Alert> : null}
              </div>

              <button type="submit" className={styles.submit} disabled={loading}>
                {loading ? (
                  <>
                    <span className={styles.spinner} />
                    Signing in…
                  </>
                ) : (
                  "Sign in"
                )}
              </button>
              <div className={styles.forgotWrap}>
                <button
                  type="button"
                  className={styles.forgot}
                  onClick={(e) => {
                    e.preventDefault();
                  }}
                >
                  Forgot password?
                </button>
              </div>
              <div className={styles.accountDivider}><span>or</span></div>
              <div className={styles.newAccount}>
                <span>New to PharmaCeylon?</span>
                <Link className={styles.registerLink} href="/register">
                  Create your pharmacy workspace
                </Link>
                <small>Have an invitation? Use the email address that received it.</small>
              </div>
            </form>
          </div>
          <div className={styles.brandColumn}>
            <div className={styles.iconBubble}>
              <TempBrandMark />
            </div>
            <h2 className={styles.brandName}>PharmaCeylon</h2>
            <p className={styles.tagline}>Everything your pharmacy needs, in one connected workspace.</p>
            <ul className={styles.brandFeatures}>
              <li>Sales and checkout</li>
              <li>Inventory and purchasing</li>
              <li>Reports across every branch</li>
            </ul>
          </div>
        </div>
      </div>
      <footer className={styles.footer}>
        © 2026 PharmaCeylon. All rights reserved.
      </footer>
    </main>
  );
}
