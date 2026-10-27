import { Alert } from "@/components/alert";
import { StatusBadge } from "./status-badge";
import css from "./approval-evidence-panel.module.css";

/** One person's part in an approval: who, and when. `null` means nobody has done it yet. */
export type ApprovalParty = { name: string; at?: string | null } | null;

export type ApprovalEvidencePanelProps = {
  /** The material version the approval covers. `null` while nothing has been approved. */
  approvedVersion: number | null;
  /**
   * The document's current material version. Ahead of `approvedVersion` means someone changed
   * what was approved, which needs fresh approval. Note-only edits don't move the material
   * version, so they never trigger the warning and the approval stands.
   */
  currentVersion?: number | null;
  /** The document's status key, shown through `StatusBadge`. */
  status: string;
  statusLabel?: string;
  requester: ApprovalParty;
  approver: ApprovalParty;
  executor: ApprovalParty;
  title?: string;
  className?: string;
};

export const STALE_APPROVAL_MESSAGE = "Changed since approval — needs fresh approval.";

function formatWhen(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function Party({ party, pending }: { party: ApprovalParty; pending: string }) {
  if (!party) return <span className={css.pending}>{pending}</span>;
  const when = party.at ? formatWhen(party.at) : null;
  return (
    <>
      <span className={css.name}>{party.name}</span>
      {when && (
        <time className={css.when} dateTime={party.at!}>
          {when}
        </time>
      )}
    </>
  );
}

/**
 * Wherever a document is approved, its evidence: the version that was approved, where it stands,
 * and the requester, approver and executor as three separate people (WEB_BACKOFFICE_TARGET.md,
 * "Approvals show their evidence"). One person may hold more than one part; the panel still
 * names each part on its own line, so nobody has to infer who did what.
 */
export function ApprovalEvidencePanel({
  approvedVersion,
  currentVersion,
  status,
  statusLabel,
  requester,
  approver,
  executor,
  title = "Approval",
  className,
}: ApprovalEvidencePanelProps) {
  const stale =
    approvedVersion != null && currentVersion != null && currentVersion > approvedVersion;

  return (
    <section
      className={`${css.panel}${className ? ` ${className}` : ""}`}
      aria-label={title}
    >
      <header className={css.header}>
        <h3 className={css.title}>{title}</h3>
        <StatusBadge status={status} label={statusLabel} />
      </header>

      {stale && (
        <Alert variant="warning" className={css.stale}>
          {STALE_APPROVAL_MESSAGE}
        </Alert>
      )}

      <dl className={css.facts}>
        <div className={css.fact}>
          <dt>Approved version</dt>
          <dd>
            {approvedVersion == null ? (
              <span className={css.pending}>Not approved yet</span>
            ) : (
              <span className={css.name}>
                Version {approvedVersion}
                {stale && <span className={css.current}> · now version {currentVersion}</span>}
              </span>
            )}
          </dd>
        </div>
        <div className={css.fact}>
          <dt>Requested by</dt>
          <dd>
            <Party party={requester} pending="—" />
          </dd>
        </div>
        <div className={css.fact}>
          <dt>Approved by</dt>
          <dd>
            <Party party={approver} pending="Not approved yet" />
          </dd>
        </div>
        <div className={css.fact}>
          <dt>Executed by</dt>
          <dd>
            <Party party={executor} pending="Not done yet" />
          </dd>
        </div>
      </dl>
    </section>
  );
}
