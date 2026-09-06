"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { Alert } from "@/components/alert";
import { IconCheck, IconEye, IconEyeOff, IconFirstAid, IconMail, IconShield } from "@/components/icons";
import { SetupJourneyPanel } from "@/components/setup-journey-panel/setup-journey-panel";
import { persistUser, setBranchId } from "@/lib/auth-session";
import {
  acceptStaffInvitation,
  getStaffInvitation,
  type InvitationDetails,
} from "@/lib/staff-invitation-client";
import styles from "./invite.module.css";

export default function StaffInvitationPage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const [details, setDetails] = useState<InvitationDetails | null>(null);
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!token) return;
    void getStaffInvitation(token)
      .then((result) => {
        setDetails(result);
        setFullName(result.fullName);
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Invitation unavailable"))
      .finally(() => setLoading(false));
  }, [token]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!details) return;
    setError(null);
    if (!details.accountExists && password !== confirmation) {
      setError("Passwords do not match.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (!details.accountExists && (!/\d/.test(password) || !/[^A-Za-z0-9]/.test(password))) {
      setError("Use at least 8 characters, including a number and a symbol.");
      return;
    }
    setSubmitting(true);
    try {
      const response = await acceptStaffInvitation(token, {
        password,
        ...(!details.accountExists ? { fullName: fullName.trim() } : {}),
      });
      persistUser(response.user);
      setBranchId(response.user.branchRoles[0]?.branchId ?? null);
      router.replace("/dashboard?invitation=accepted");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not accept invitation");
      setSubmitting(false);
    }
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link href="/login" className={styles.brand}>
          <span className={styles.brandMark}><IconFirstAid size={19} /></span>
          PharmaCeylon
        </Link>
        <span>Already use PharmaCeylon? <Link href="/login">Sign in</Link></span>
      </header>
      <section className={styles.card}>
        <div className={styles.formPanel}>
          <p className={styles.eyebrow}>STAFF INVITATION</p>
          {loading ? <div className={styles.loading}>Checking your invitation…</div> : null}
          {!loading && !details ? (
            <div className={styles.empty}>
              <IconMail size={30} />
              <h1>This invitation isn’t available</h1>
              <p>It may have expired, been revoked, or already been accepted.</p>
              {error ? <Alert variant="error">{error}</Alert> : null}
              <Link href="/login" className={styles.secondary}>Go to sign in</Link>
            </div>
          ) : null}
          {details ? (
            <div className={styles.formScroll}>
              <h1>Join {details.pharmacyName}</h1>
              <p className={styles.lead}>{details.invitedByName} has prepared your workspace access.</p>
              <div className={styles.summary}>
                <div><IconMail size={16} /><span><small>Invited email</small>{details.email}</span></div>
                {details.assignments.map((assignment, index) => (
                  <div key={`${assignment.branchName}-${assignment.roleName}-${index}`}>
                    <IconCheck size={16} />
                    <span><small>{assignment.roleName}</small>{assignment.branchName}</span>
                  </div>
                ))}
              </div>
              <form className={styles.form} onSubmit={submit}>
                {!details.accountExists ? (
                  <label>Full name<input value={fullName} onChange={(event) => setFullName(event.target.value)} required /></label>
                ) : (
                  <div className={styles.existing}><IconShield size={16} /><span>An account already exists for this email. Enter its password to join this pharmacy.</span></div>
                )}
                <PasswordField label={details.accountExists ? "Account password" : "Create password"} value={password} visible={showPassword} onVisibleChange={setShowPassword} onChange={setPassword} autoComplete={details.accountExists ? "current-password" : "new-password"} />
                {!details.accountExists ? (
                  <>
                    <PasswordField label="Confirm password" value={confirmation} visible={showConfirmation} onVisibleChange={setShowConfirmation} onChange={setConfirmation} autoComplete="new-password" />
                    <div className={styles.passwordRules} aria-label="Password requirements">
                      <span data-met={password.length >= 8}><IconCheck size={13} /> 8 characters</span>
                      <span data-met={/\d/.test(password)}><IconCheck size={13} /> One number</span>
                      <span data-met={/[^A-Za-z0-9]/.test(password)}><IconCheck size={13} /> One symbol</span>
                    </div>
                  </>
                ) : null}
                {error ? <Alert variant="error">{error}</Alert> : null}
                <button className={styles.submit} disabled={submitting}>{submitting ? "Joining workspace…" : "Accept invitation and continue"}</button>
                <p className={styles.security}><IconShield size={15} /> This invitation adds access only to the pharmacy shown above.</p>
              </form>
            </div>
          ) : null}
        </div>
        <SetupJourneyPanel currentStep={2} variant="staff" />
      </section>
    </main>
  );
}

function PasswordField({ label, value, visible, onVisibleChange, onChange, autoComplete }: {
  label: string;
  value: string;
  visible: boolean;
  onVisibleChange: (value: boolean) => void;
  onChange: (value: string) => void;
  autoComplete: "current-password" | "new-password";
}) {
  return <label>{label}<span className={styles.passwordControl}>
    <input type={visible ? "text" : "password"} autoComplete={autoComplete} value={value} onChange={(event) => onChange(event.target.value)} required />
    <button type="button" onClick={() => onVisibleChange(!visible)} aria-label={visible ? `Hide ${label}` : `Show ${label}`}>
      {visible ? <IconEyeOff size={18} /> : <IconEye size={18} />}
    </button>
  </span></label>;
}
