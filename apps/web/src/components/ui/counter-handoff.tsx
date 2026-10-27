import { IconHome } from "@/components/icons";
import css from "./counter-handoff.module.css";

export type CounterHandoffProps = {
  /** The branch whose counter does it. */
  branchName: string;
  /** Who can do it there — role names or people, e.g. ["Pharmacist", "Manager"]. */
  whoCan?: string[];
  /** What happens at the counter, e.g. "Receive the goods". */
  action?: string;
  /**
   * `approved`: the document is approved and waits for someone at the counter.
   * `counter_only`: an execute button replaced at a live branch; nothing is waiting yet.
   */
  variant?: "approved" | "counter_only";
  className?: string;
};

export const COUNTER_HANDOFF_HEADLINES = {
  approved: "Approved — waiting at the counter",
  counter_only: "Do this at the counter in PharmaCeylon POS.",
} as const;

/** "Pharmacist", "Pharmacist or Manager", "Pharmacist, Manager or Owner". */
function joinWithOr(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

/**
 * Where a web page used to have an execute button, the handoff to the counter: the step happens
 * in PharmaCeylon POS at the branch, and the web says which branch and who can do it there
 * (WEB_BACKOFFICE_TARGET.md, "Copy patterns").
 */
export function CounterHandoff({
  branchName,
  whoCan = [],
  action,
  variant = "approved",
  className,
}: CounterHandoffProps) {
  const who = joinWithOr(whoCan.filter(Boolean));
  // The counter-only headline already names PharmaCeylon POS; don't say it twice.
  const where = variant === "approved" ? "in PharmaCeylon POS at" : "at";
  const lead = action
    ? `${action} ${where} `
    : `${where.charAt(0).toUpperCase()}${where.slice(1)} `;
  return (
    <div
      className={`${css.handoff}${className ? ` ${className}` : ""}`}
      role="status"
      data-variant={variant}
    >
      <span className={css.icon} aria-hidden>
        <IconHome size={16} />
      </span>
      <div className={css.body}>
        <p className={css.headline}>{COUNTER_HANDOFF_HEADLINES[variant]}</p>
        <p className={css.detail}>
          {lead}
          <strong>{branchName}</strong>.
          {who && <> {who} can do it.</>}
        </p>
      </div>
    </div>
  );
}
