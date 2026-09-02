"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import {
  IconCheck,
  IconCheckCircle,
  IconFirstAid,
  IconMail,
  IconShield,
} from "@/components/icons";
import {
  fetchOwnerRegistrationStatus,
  resendOwnerVerification,
  verifyOwnerEmail,
} from "@/lib/owner-registration-client";
import styles from "./verify-email.module.css";

type State = "waiting" | "verifying" | "verified" | "error";

export default function VerifyEmailPage() {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [state, setState] = useState<State>("waiting");
  const [message, setMessage] = useState("");
  const [resending, setResending] = useState(false);

  useEffect(() => {
    const pendingEmail = sessionStorage.getItem("pc_pending_owner_email") ?? "";
    setEmail(pendingEmail);

    void fetchOwnerRegistrationStatus()
      .then((session) => {
        setEmail(session.email);
        setState("verified");
      })
      .catch(() => {
        const params = new URLSearchParams(
          window.location.hash.replace(/^#/, ""),
        );
        const legacyToken = params.get("token");
        if (!legacyToken || !pendingEmail) return;
        window.history.replaceState(null, "", "/verify-email");
        void submitCode(pendingEmail, legacyToken);
      });
    // The legacy link path runs only once on page entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submitCode(targetEmail = email, targetCode = code) {
    if (!targetEmail.trim()) {
      setState("error");
      setMessage("Enter the email address you registered with.");
      return;
    }
    if (!targetCode.trim()) {
      setState("error");
      setMessage("Enter the verification code from your email.");
      return;
    }
    setState("verifying");
    setMessage("");
    try {
      const session = await verifyOwnerEmail(targetEmail, targetCode);
      sessionStorage.removeItem("pc_pending_owner_email");
      setEmail(session.email);
      setState("verified");
      setCode("");
    } catch (cause) {
      setState("error");
      setMessage(
        cause instanceof Error ? cause.message : "Verification failed.",
      );
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await submitCode();
  }

  async function resend() {
    if (!email.trim()) {
      setState("error");
      setMessage("Enter your registered email before requesting another code.");
      return;
    }
    setResending(true);
    setMessage("");
    try {
      await resendOwnerVerification(email);
      sessionStorage.setItem(
        "pc_pending_owner_email",
        email.trim().toLowerCase(),
      );
      setState("waiting");
      setMessage(
        "A fresh 6-digit code has been sent. The previous code is no longer valid.",
      );
    } catch (cause) {
      setState("error");
      setMessage(
        cause instanceof Error
          ? cause.message
          : "Unable to resend verification.",
      );
    } finally {
      setResending(false);
    }
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link href="/login" className={styles.brand}>
          <span>
            <IconFirstAid size={19} />
          </span>
          PharmaCeylon
        </Link>
        <Link href="/register">Wrong email? Start again</Link>
      </header>

      <section className={styles.card} aria-live="polite">
        <div className={styles.verifyPanel}>
          <div className={styles.stage}>
            <span className={styles.done}>
              <IconCheck size={14} />
            </span>
            <b>Account</b>
            <i />
            <span className={styles.active}>2</span>
            <b>Verify</b>
            <i />
            <span>3</span>
            <b>Workspace</b>
          </div>
          <div className={styles.icon}>
            {state === "verified" ? (
              <IconCheckCircle size={38} />
            ) : (
              <IconMail size={38} />
            )}
          </div>

          {state === "verified" ? (
            <div className={styles.successContent}>
              <p className={styles.eyebrow}>STEP 2 OF 3 · COMPLETE</p>
              <h1>Email verified</h1>
              <p>
                Your owner identity is confirmed. Next, add the essentials for
                your pharmacy workspace.
              </p>
              <div className={styles.verifiedEmail}>
                <IconShield size={17} />
                <span>{email}</span>
                <b>Verified</b>
              </div>
              <Link className={styles.primary} href="/onboarding">
                Continue to workspace setup
              </Link>
            </div>
          ) : (
            <>
              <p className={styles.eyebrow}>STEP 2 OF 3 · VERIFY EMAIL</p>
              <h1>Enter the code from your email</h1>
              <p className={styles.lead}>
                We sent a 6-digit verification code to your inbox. Enter it here
                so setup continues in this browser.
              </p>
              <form className={styles.form} onSubmit={submit}>
                <label>
                  Email address
                  <input
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    required
                  />
                </label>
                <label>
                  Verification code
                  <input
                    className={styles.codeInput}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    placeholder="000000"
                    value={code}
                    onChange={(event) =>
                      setCode(event.target.value.replace(/\D/g, "").slice(0, 6))
                    }
                    required
                  />
                </label>
                {message ? (
                  <p
                    className={state === "error" ? styles.error : styles.notice}
                  >
                    {message}
                  </p>
                ) : null}
                <button
                  className={styles.primary}
                  disabled={state === "verifying"}
                >
                  {state === "verifying" ? "Verifying…" : "Verify email"}
                </button>
              </form>
              <div className={styles.resend}>
                <span>Didn’t receive the code?</span>
                <button type="button" onClick={resend} disabled={resending}>
                  {resending ? "Sending…" : "Send a new code"}
                </button>
              </div>
            </>
          )}
        </div>

        <aside className={styles.contextPanel}>
          <p className={styles.panelEyebrow}>YOUR SETUP JOURNEY</p>
          <h2>
            {state === "verified"
              ? "Account ready. Pharmacy next."
              : "Secure your new account."}
          </h2>
          <ol>
            <li className={styles.complete}>
              <span>
                <IconCheck size={15} />
              </span>
              <div>
                <b>Owner account</b>
                <small>Your account details are saved.</small>
              </div>
            </li>
            <li
              className={
                state === "verified" ? styles.complete : styles.current
              }
            >
              <span>{state === "verified" ? <IconCheck size={15} /> : 2}</span>
              <div>
                <b>Email verification</b>
                <small>
                  {state === "verified"
                    ? "Your email is confirmed."
                    : "You are here now."}
                </small>
              </div>
            </li>
            <li>
              <span>3</span>
              <div>
                <b>Workspace setup</b>
                <small>Pharmacy, branch and preferences.</small>
              </div>
            </li>
          </ol>
          <div className={styles.helpNote}>
            <IconShield size={20} />
            <div>
              <b>Why verify?</b>
              <span>
                It protects ownership of your future pharmacy workspace.
              </span>
            </div>
          </div>
        </aside>
      </section>
    </main>
  );
}
