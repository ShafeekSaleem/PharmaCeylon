"use client";

import type {
  CounterJournalSyncStatus,
  TerminalCounterView,
  TerminalEnrollmentCodeView,
} from "@pharmaceylon/shared";
import { formatDisplayDate, formatDisplayTime } from "@pharmaceylon/shared";
import { IconAlertTriangle, IconMonitor } from "@/components/icons";
import { ModalButton, StatusBadge } from "@/components/ui";
import { RowMenu, type RowMenuAction } from "@/components/ui/row-menu";
import { CounterOfflineSales, syncTime } from "./offline-sync";
import css from "./counters.module.css";

export type CounterCardAction =
  | "issue-code"
  | "rename"
  | "stop"
  | "reactivate"
  | "delete"
  | "report-lost"
  | "retire";

/** Why a counter cannot be stopped yet, in words for staff; null when it can. */
export function stopBlocker(counter: TerminalCounterView): string | null {
  if (counter.terminal) return "A computer is still set up here. Retire it first.";
  if (counter.hasOpenShift) return "A shift is still open here. Close it first.";
  return null;
}

/** Why a counter cannot be deleted; null when it has never been used. */
export const deleteBlocker = (counter: TerminalCounterView): string | null =>
  counter.hasHistory ? "Used before, so its records are kept. Stop using it instead." : null;

/** The counter's state in plain words. Only what the counters API reports is claimed. */
export function counterState(counter: TerminalCounterView): {
  status: string;
  label: string;
  variant: "success" | "warning" | "muted";
} {
  if (!counter.isActive) return { status: "retired", label: "Retired", variant: "muted" };
  if (!counter.terminal) return { status: "empty", label: "No computer yet", variant: "muted" };
  if (!counter.terminal.enrollmentId)
    return { status: "revoked", label: "Key revoked", variant: "warning" };
  return { status: "in_use", label: "In use", variant: "success" };
}

/**
 * One counter at the branch: what it is, the one thing to do next, the rest in a menu, and the
 * computer's lost/retire actions in a quieter row of their own (UI1 #205).
 */
export function CounterCard({
  counter,
  code,
  journal,
  journalFailed,
  similarTo,
  revokingCode,
  onAction,
  onRevokeCode,
}: {
  counter: TerminalCounterView;
  /** An enrolment code still waiting to be used for this counter. */
  code: TerminalEnrollmentCodeView | undefined;
  journal: CounterJournalSyncStatus | null;
  journalFailed: boolean;
  /** Another counter whose name staff could mistake for this one's. */
  similarTo: string | null;
  revokingCode: boolean;
  onAction: (action: CounterCardAction) => void;
  onRevokeCode: (codeId: string) => void;
}) {
  const state = counterState(counter);
  const name = counter.label;
  const titleId = `counter-${counter.registerId}-title`;
  const terminal = counter.terminal;
  const needsComputer = counter.isActive && !terminal;

  const primary = !counter.isActive
    ? { label: "Use again", action: "reactivate" as const }
    : needsComputer
      ? { label: "Get enrolment code", action: "issue-code" as const }
      : { label: "Rename", action: "rename" as const };

  const stop = stopBlocker(counter);
  const del = deleteBlocker(counter);
  const menu: RowMenuAction[] = [];
  if (primary.action !== "rename")
    menu.push({ label: "Rename", onClick: () => onAction("rename") });
  if (counter.isActive)
    menu.push({
      label: "Stop using",
      disabled: stop !== null,
      hint: stop ?? undefined,
      onClick: () => onAction("stop"),
    });
  menu.push({
    label: "Delete",
    danger: true,
    disabled: del !== null,
    hint: del ?? undefined,
    onClick: () => onAction("delete"),
  });

  return (
    <section
      className={`${css.counterCard}${counter.isActive ? "" : ` ${css.counterCardRetired}`}`}
      aria-labelledby={titleId}
    >
      <div className={css.head}>
        <span className={css.iconTile} aria-hidden="true">
          <IconMonitor size={18} />
        </span>
        <div className={css.identity}>
          <div className={css.nameRow}>
            <h3 id={titleId} className={css.name}>
              {name}
            </h3>
            <StatusBadge status={state.status} label={state.label} variant={state.variant} />
          </div>
          <p className={css.computer}>
            {terminal
              ? `${terminal.label}${
                  terminal.enrolledAt ? ` · enrolled ${formatDisplayDate(terminal.enrolledAt)}` : ""
                }`
              : code
                ? "Enrolment code issued"
                : "No computer enrolled"}
          </p>
        </div>
        <div className={css.actions}>
          <ModalButton
            variant={primary.action === "rename" ? "secondary" : "primary"}
            onClick={() => onAction(primary.action)}
          >
            {primary.label}
          </ModalButton>
          <RowMenu label={name} actions={menu} />
        </div>
      </div>

      {similarTo ? (
        <p className={css.similar} role="note">
          <IconAlertTriangle size={14} aria-hidden="true" />
          The name is close to &ldquo;{similarTo}&rdquo;. Rename it so staff can tell them apart.
        </p>
      ) : null}

      {needsComputer ? (
        <div className={css.steps}>
          <ol>
            <li>Get a code here. It works once, on one computer, before it expires.</li>
            <li>
              Open PharmaCeylon POS on the new computer and enter it. A manager can instead sign in
              there and choose this counter.
            </li>
            <li>Each person who sells there signs in once while it is online.</li>
          </ol>
          {code ? (
            <div className={css.codeRow}>
              <span>Code waiting, expires {formatDisplayTime(code.expiresAt)}</span>
              <ModalButton
                variant="secondary"
                onClick={() => onRevokeCode(code.codeId)}
                loading={revokingCode}
                aria-label={`Revoke the waiting code for ${name}`}
              >
                Revoke code
              </ModalButton>
            </div>
          ) : null}
        </div>
      ) : (
        <dl className={css.facts}>
          <div className={css.fact}>
            <dt>Last offline upload</dt>
            <dd>
              <LastUpload counter={counter} journal={journal} failed={journalFailed} />
            </dd>
          </div>
          <div className={css.fact}>
            <dt>Offline sales received</dt>
            <dd>
              <CounterOfflineSales
                counter={counter}
                journal={journal?.enrollments ?? null}
                timeZone={journal?.timezone ?? "Asia/Colombo"}
                failed={journalFailed}
                brief
              />
            </dd>
          </div>
          <div className={css.fact}>
            <dt>Open shift</dt>
            <dd>{counter.hasOpenShift ? "A shift is open" : "None"}</dd>
          </div>
        </dl>
      )}

      {terminal ? (
        <div className={css.quietRow}>
          <span>Computer lost, stolen or being replaced?</span>
          <span className={css.quietActions}>
            {terminal.enrollmentId ? (
              <button type="button" className={css.linkBtn} onClick={() => onAction("report-lost")}>
                Report lost
              </button>
            ) : null}
            <button
              type="button"
              className={`${css.linkBtn} ${css.linkDanger}`}
              onClick={() => onAction("retire")}
            >
              Retire this computer
            </button>
          </span>
        </div>
      ) : null}
    </section>
  );
}

/**
 * When the counter's current key last sent the server offline sales. Counters don't report in
 * otherwise, so this is the closest the page can honestly come to "last heard from".
 */
function LastUpload({
  counter,
  journal,
  failed,
}: {
  counter: TerminalCounterView;
  journal: CounterJournalSyncStatus | null;
  failed: boolean;
}) {
  const enrollmentId = counter.terminal?.enrollmentId ?? null;
  if (!enrollmentId) return <span className={css.muted}>—</span>;
  if (failed) return <span className={css.muted}>Couldn&apos;t check</span>;
  if (journal === null) return <span className={css.muted}>Checking…</span>;
  const view = journal.enrollments.find((v) => v.enrollmentId === enrollmentId);
  const last = view?.lastReceivedAt ?? view?.head?.acceptedAt ?? null;
  if (last === null) return <span className={css.muted}>Nothing sent yet</span>;
  return <>{syncTime(last, journal.timezone)}</>;
}
