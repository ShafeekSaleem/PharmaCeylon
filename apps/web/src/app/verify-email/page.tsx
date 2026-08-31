"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  resendOwnerVerification,
  verifyOwnerEmail,
} from "@/lib/owner-registration-client";
import styles from "./verify-email.module.css";

type State = "waiting" | "verifying" | "verified" | "error";

export default function VerifyEmailPage() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<State>("waiting");
  const [message, setMessage] = useState("");
  const [resending, setResending] = useState(false);

  useEffect(() => {
    setEmail(sessionStorage.getItem("pc_pending_owner_email") ?? "");
    const hash = window.location.hash;
    const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
    const token = params.get("token");
    if (!token) return;

    window.history.replaceState(null, "", "/verify-email");
    setState("verifying");
    void verifyOwnerEmail(token)
      .then((session) => {
        sessionStorage.removeItem("pc_pending_owner_email");
        setEmail(session.email);
        setState("verified");
      })
      .catch((cause) => {
        setState("error");
        setMessage(cause instanceof Error ? cause.message : "Verification failed.");
      });
  }, []);

  async function resend() {
    if (!email) return;
    setResending(true);
    setMessage("");
    try {
      await resendOwnerVerification(email);
      setMessage("A new verification email has been sent.");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Unable to resend verification.");
    } finally {
      setResending(false);
    }
  }

  return (
    <main className={styles.page}>
      <header><Link href="/login">PharmaCeylon</Link><Link href="/login">Wrong account? Sign out</Link></header>
      <section className={styles.card} aria-live="polite">
        <div className={styles.progress}><span className={styles.done}>✓<small>Account</small></span><i /><span className={styles.active}>2<small>Verify email</small></span><i /><span>3<small>Workspace setup</small></span></div>
        <div className={styles.icon}>{state === "verified" ? "✓" : "✉"}</div>
        {state === "verifying" ? (
          <><h1>Verifying your email…</h1><p>Please keep this page open for a moment.</p></>
        ) : state === "verified" ? (
          <>
            <h1>Email verified</h1>
            <p>Your owner account is ready. Continue to create your pharmacy workspace.</p>
            <Link className={styles.primary} href="/onboarding/pharmacy">Continue setup</Link>
          </>
        ) : (
          <>
            <h1>{state === "error" ? "We couldn’t verify this link" : "Check your email"}</h1>
            {state === "error" ? <p className={styles.error}>{message}</p> : <p>We sent a verification link{email ? <> to <strong>{email}</strong></> : null}.</p>}
            <p>Open the link to confirm your email and continue setting up your pharmacy.</p>
            {email ? <button className={styles.secondary} onClick={resend} disabled={resending}>{resending ? "Sending…" : "Resend verification email"}</button> : <Link className={styles.secondary} href="/register">Return to registration</Link>}
            {message && state !== "error" ? <p className={styles.success}>{message}</p> : null}
          </>
        )}
        <div className={styles.links}><Link href="/register">Change email address</Link><Link href="/login">Sign out</Link></div>
      </section>
      <p className={styles.help}>Need help? Contact your PharmaCeylon representative.</p>
    </main>
  );
}
