import { IconCheck } from "@/components/icons";
import styles from "./setup-journey-panel.module.css";

const OWNER_JOURNEY = [
  [
    "Create your owner account",
    "Tell us who will own and manage the workspace.",
  ],
  ["Verify your email", "Enter the secure code we send to your inbox."],
  [
    "Set up your pharmacy",
    "Add the business, first branch and starting preferences.",
  ],
] as const;

const STAFF_JOURNEY = [
  ["Invitation received", "Review the pharmacy, role and branch access."],
  ["Secure your account", "Sign in or create your own secure password."],
  ["Enter the workspace", "Start directly in your assigned pharmacy branch."],
] as const;

type Props = {
  /** Which of the 3 journey steps the current page represents (1-indexed). */
  currentStep: 1 | 2 | 3;
  variant?: "owner" | "staff";
};

/**
 * The right-hand panel shared by the owner-registration flow's pages (create account, verify
 * email). The headline and lead copy are intentionally static across pages — only which step
 * is marked complete/current updates, so the panel reads as one constant reference to the
 * whole journey rather than swapping its message per page.
 */
export function SetupJourneyPanel({ currentStep, variant = "owner" }: Props) {
  const journey = variant === "staff" ? STAFF_JOURNEY : OWNER_JOURNEY;
  return (
    <aside className={styles.panel}>
      <p className={styles.eyebrow}>{variant === "staff" ? "YOUR INVITATION" : "YOUR SETUP JOURNEY"}</p>
      <h2>{variant === "staff" ? "Join your pharmacy team." : "Begin with your owner account."}</h2>
      <p className={styles.lead}>
        {variant === "staff"
          ? "Your access is already prepared. Confirm your identity and get to work."
          : "A guided path from account creation to a pharmacy ready for setup."}
      </p>
      <ol>
        {journey.map(([title, description], index) => {
          const step = index + 1;
          const isComplete = step < currentStep;
          const isCurrent = step === currentStep;
          return (
            <li
              key={title}
              className={
                isComplete ? styles.complete : isCurrent ? styles.active : ""
              }
            >
              <span>{isComplete ? <IconCheck size={15} /> : step}</span>
              <div>
                <b>{title}</b>
                <small>{description}</small>
              </div>
            </li>
          );
        })}
      </ol>
      <div className={styles.timeNote}>
        <b>{variant === "staff" ? "Secure invitation" : "About 4 minutes"}</b>
        <span>
          {variant === "staff"
            ? "Only the invited email can accept this access."
            : "Your progress is saved as you go."}
        </span>
      </div>
    </aside>
  );
}
