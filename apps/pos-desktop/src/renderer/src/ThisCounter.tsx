import { useEffect, useState } from "react";
import type {
  ActionError,
  AppInfo,
  CheckStatus,
  DeviceState,
  EnrollmentOfflineBackup,
  OfflineBackup,
  OfflineCounterView,
  Printer,
  ReadinessCheck,
  ReadinessReport,
} from "../../shared/ipc-contract";
import { dayMonthYear, relativeTime, time } from "./format";
import {
  formatOfflineActivated,
  formatOfflineAuthorized,
  tillDisplayName,
} from "./this-counter-display";
import { Icon } from "./Icon";
import { KeyHint } from "./KeyHint";
import { useKeyBinding } from "./keymap";
import { atTheComputer } from "./Shell";
import styles from "./ThisCounter.module.css";
import ui from "./ui.module.css";
import { cx, ErrorLine, useAction } from "./useAction";

const STATUS_LABEL: Record<CheckStatus, string> = {
  ok: "OK",
  warning: "Check",
  failed: "Failed",
  not_ready: "Not set up",
};

const STATUS_PILL: Record<CheckStatus, string | undefined> = {
  ok: ui.ok,
  warning: ui.warn,
  failed: ui.bad,
  not_ready: ui.neutral,
};

/** The readiness checks in the mockup's three groups; any check not listed lands in the first. */
const GROUPS: { title: string; ids: string[] }[] = [
  {
    title: "This computer",
    ids: ["database", "schema", "credential-store", "device", "printer"],
  },
  { title: "Staff and records", ids: ["staff", "unconfirmed"] },
  {
    title: "Offline backup",
    ids: ["grant", "catalogue", "receipt-numbers", "sync"],
  },
];

function grouped(checks: ReadinessCheck[]) {
  const known = new Set(GROUPS.flatMap((g) => g.ids));
  return GROUPS.map((group, index) => ({
    title: group.title,
    checks: checks.filter(
      (c) => group.ids.includes(c.id) || (index === 0 && !known.has(c.id)),
    ),
  })).filter((group) => group.checks.length > 0);
}

function Readiness({
  readiness,
  onCheck,
}: {
  readiness: ReadinessReport | null;
  onCheck: () => void;
}) {
  return (
    <div className={cx(ui.panel, styles.readiness)}>
      <div className={cx(ui.ph, styles.ph)}>
        <h2>Readiness</h2>
        {readiness && (
          <span className={styles.phNote}>
            Checked {time(new Date(readiness.checkedAt))}
          </span>
        )}
        {readiness && (
          <span
            className={cx(
              ui.pill,
              readiness.ready ? ui.ok : ui.warn,
              styles.right,
            )}
          >
            <Icon name={readiness.ready ? "check" : "alert-triangle"} />
            {readiness.ready
              ? "Ready to sell during an outage"
              : "Not ready for an outage"}
          </span>
        )}
        <button
          type="button"
          className={cx(ui.btn, ui.sm, ui.outline, !readiness && styles.right)}
          onClick={onCheck}
        >
          <Icon name="refresh" />
          Check again
        </button>
      </div>
      <div className={styles.scroll}>
        {readiness === null ? (
          <p className={cx(ui.muted, styles.loading)}>Checking…</p>
        ) : (
          grouped(readiness.checks).map((group) => (
            <div key={group.title}>
              <div className={ui.subH}>{group.title}</div>
              <div className={styles.rdG}>
                {group.checks.map((check) => (
                  <div key={check.id} className={styles.rd}>
                    <span className={cx(ui.pill, STATUS_PILL[check.status])}>
                      {check.status === "ok" && <Icon name="check" />}
                      {STATUS_LABEL[check.status]}
                    </span>
                    <b>{check.label}</b>
                    <span
                      className={cx(
                        styles.d,
                        check.status !== "ok" && styles.dWrap,
                      )}
                      title={check.detail}
                    >
                      {check.detail}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
      <div className={styles.rdFoot}>
        Each check shows OK, Check, Failed or Not set up. The counter is ready
        for an outage only when every check is OK.
      </div>
    </div>
  );
}

function PrinterTest() {
  const [printers, setPrinters] = useState<Printer[] | null>(null);
  const [selected, setSelected] = useState("");
  const [printing, setPrinting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const [printed, setPrinted] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<{
    at: string;
    byName: string | null;
  } | null>(null);

  useEffect(() => {
    window.pos
      .listPrinters()
      .then((list) => {
        setPrinters(list);
        setSelected(list[0]?.name ?? "");
      })
      .catch(() => setPrinters([]));
  }, []);

  async function print() {
    setPrinting(true);
    setMessage(null);
    setConfirmed(null);
    try {
      const result = await window.pos.printTestReceipt({
        printerName: selected,
      });
      setMessage(
        result.ok
          ? { ok: true, text: `Sent to the printer at ${time(new Date())}` }
          : {
              ok: false,
              text: result.error ?? "The test receipt did not print.",
            },
      );
      setPrinted(result.ok ? selected : null);
    } catch {
      setMessage({ ok: false, text: "The test receipt did not print." });
    } finally {
      setPrinting(false);
    }
  }

  async function confirm() {
    if (!printed || printing || confirming) return;
    setConfirming(true);
    try {
      const result = await window.pos
        .confirmTestReceipt({ printerName: printed })
        .catch(() => null);
      if (result?.ok) {
        setConfirmed({
          at: result.value.confirmedAt,
          byName: result.value.confirmedByName,
        });
        setPrinted(null);
        setMessage(null);
      } else
        setMessage({
          ok: false,
          text:
            result && !result.ok
              ? result.error.message
              : "Could not record it.",
        });
    } finally {
      setConfirming(false);
    }
  }

  // While the page asks whether the test receipt came out, answering yes is its main action.
  const asking = Boolean(printed) && !printing && !confirming;
  useKeyBinding("Ctrl+Enter", () => void confirm(), { enabled: asking });

  const pill = confirmed && !printed ? (
    <span className={cx(ui.pill, ui.ok, styles.right)}>
      <Icon name="check" />
      Ready
    </span>
  ) : printers?.length === 0 ? (
    <span className={cx(ui.pill, ui.warn, styles.right)}>No printer</span>
  ) : (
    <span className={cx(ui.pill, ui.neutral, styles.right)}>
      Test receipt not confirmed
    </span>
  );

  return (
    <div className={ui.panel}>
      <div className={cx(ui.ph, styles.ph)}>
        <h2>Receipt printer</h2>
        {printers !== null && pill}
      </div>
      <div className={styles.prB}>
        {printers === null ? (
          <p className={ui.muted}>Looking for printers…</p>
        ) : printers.length === 0 ? (
          <div className={cx(ui.note, ui.noteWarn)}>
            <Icon name="alert-triangle" />
            <div>No printers are installed in Windows on this computer.</div>
          </div>
        ) : (
          <>
            <div className={ui.f}>
              <label htmlFor="printer" className={ui.label}>
                Printer <span>Installed in Windows</span>
              </label>
              <div className={ui.select}>
                <select
                  id="printer"
                  className={ui.in}
                  value={selected}
                  onChange={(event) => setSelected(event.target.value)}
                  disabled={printing}
                >
                  {printers.map((printer) => (
                    <option key={printer.name} value={printer.name}>
                      {printer.displayName}
                    </option>
                  ))}
                </select>
                <Icon name="chevron-down" />
              </div>
            </div>
            <div className={styles.prRow}>
              <button
                type="button"
                className={cx(ui.btn, ui.outline)}
                onClick={() => void print()}
                disabled={printing || confirming || !selected}
              >
                <Icon name="printer" />
                {printing ? "Printing…" : "Print test receipt"}
              </button>
              {message && (
                <span
                  role="status"
                  className={message.ok ? undefined : ui.badText}
                >
                  {message.text}
                </span>
              )}
            </div>
          </>
        )}
        {printed && (
          <div className={styles.ask}>
            <Icon name="receipt" />
            <div>
              <b>Did the test receipt come out?</b>
              <small>Recorded for the go-live checklist.</small>
            </div>
            <div className={styles.btns}>
              <button
                type="button"
                className={cx(ui.btn, ui.sm, ui.ghost)}
                onClick={() => void print()}
                disabled={printing || confirming}
              >
                Print again
              </button>
              <button
                type="button"
                className={cx(ui.btn, ui.sm, ui.primary)}
                onClick={() => void confirm()}
                disabled={printing || confirming}
              >
                <Icon name="check" />
                Yes, it came out
                {asking && (
                  <KeyHint keys="Ctrl+Enter" onPrimary small wideOnly />
                )}
              </button>
            </div>
          </div>
        )}
        {confirmed && !printed && (
          <div className={styles.footN}>
            Last confirmed {dayMonthYear(new Date(confirmed.at))}
            {confirmed.byName ? ` by ${confirmed.byName}` : ""}. Recorded for
            the branch go-live checklist. Shown for this session only.
          </div>
        )}
      </div>
    </div>
  );
}

/** GET offline-assignment returns 403 FORBIDDEN for counter roles; only then fall back to enrollment. */
function isOfflineAssignmentForbidden(error: ActionError): boolean {
  return error.code === "FORBIDDEN" || error.code === "PERMISSION_DENIED";
}

const emptyOfflineCounterView: OfflineCounterView = {
  thisCounterNominated: false,
  otherCounterNominated: false,
  nominationVersion: 0,
  authorization: null,
};

/** When offline-assignment is refused, derive nomination state from enrollment status only. */
function offlineCounterViewFromEnrollment(
  activatedAt: number | null,
): OfflineCounterView {
  return {
    ...emptyOfflineCounterView,
    thisCounterNominated: activatedAt != null,
  };
}

function OfflineCounterPanel({
  branchName,
  backup,
  enrollmentBackup,
  enrollmentFactsLive,
  enrollmentStatusFetchedAt,
}: {
  branchName: string;
  backup: OfflineBackup | null;
  enrollmentBackup: EnrollmentOfflineBackup;
  enrollmentFactsLive: boolean;
  enrollmentStatusFetchedAt: string | null;
}) {
  const [view, setView] = useState<OfflineCounterView | null>(null);
  const [viewFromEnrollment, setViewFromEnrollment] = useState(false);
  const [offlineLoadError, setOfflineLoadError] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const enrollmentActivatedAt = enrollmentBackup.activatedAt;
  const enrollmentAuthorizedAt = enrollmentBackup.authorizedAt;
  useEffect(() => {
    let alive = true;
    void window.pos
      .offlineCounter()
      .then((result) => {
        if (!alive) return;
        if (result.ok) {
          setView(result.value);
          setViewFromEnrollment(false);
          setOfflineLoadError(null);
          return;
        }
        if (isOfflineAssignmentForbidden(result.error)) {
          setView(offlineCounterViewFromEnrollment(enrollmentActivatedAt));
          setViewFromEnrollment(true);
          setOfflineLoadError(null);
          return;
        }
        setView(emptyOfflineCounterView);
        setViewFromEnrollment(false);
        setOfflineLoadError(result.error.message);
      })
      .catch(() => {
        if (!alive) return;
        setView(emptyOfflineCounterView);
        setViewFromEnrollment(false);
        setOfflineLoadError("Something went wrong. Please try again.");
      });
    return () => {
      alive = false;
    };
  }, [enrollmentActivatedAt, enrollmentAuthorizedAt]);
  if (!view) return null;

  const authorization = view.authorization;
  const enrollmentAuthorizedWaiting =
    enrollmentAuthorizedAt != null && enrollmentActivatedAt == null;
  const showEnrollmentAuthorizedWaiting =
    viewFromEnrollment &&
    enrollmentAuthorizedWaiting &&
    !view.thisCounterNominated &&
    authorization == null;
  const showEnrollmentNotThisCounter =
    viewFromEnrollment &&
    !view.thisCounterNominated &&
    !showEnrollmentAuthorizedWaiting;
  const showOfflineStatusUnchecked = offlineLoadError != null;
  const showLastKnown =
    !enrollmentFactsLive &&
    enrollmentStatusFetchedAt != null &&
    (enrollmentBackup.authorizedAt != null ||
      enrollmentBackup.activatedAt != null);
  const authorizedLine = formatOfflineAuthorized(enrollmentBackup);
  const activatedLine = formatOfflineActivated(enrollmentBackup);
  const expiresAt = backup?.grantExpiresAt
    ? new Date(backup.grantExpiresAt)
    : null;
  const [title, tone, status] = view.thisCounterNominated
    ? [
        `This is ${branchName}'s offline backup counter`,
        backup?.usable ? ui.info : ui.warn,
        backup?.usable && expiresAt
          ? `Ready until ${relativeTime(expiresAt)}`
          : "Not ready for an outage",
      ]
    : authorization || showEnrollmentAuthorizedWaiting
      ? [
          "The owner chose this counter as the offline backup",
          ui.warn,
          "Waiting for activation",
        ]
      : view.otherCounterNominated
        ? [
            "Another counter is the offline backup",
            ui.neutral,
            "Not this counter",
          ]
        : showEnrollmentNotThisCounter
          ? [
              "This counter isn't the offline backup",
              ui.neutral,
              "Not this counter",
            ]
          : showOfflineStatusUnchecked
            ? ["Couldn't check right now", ui.neutral, "Couldn't check"]
            : ["No offline backup counter yet", ui.neutral, "Not chosen"];

  return (
    <div className={cx(ui.panel, styles.grow)}>
      <div className={cx(ui.ph, styles.ph)}>
        <h2>Offline backup counter</h2>
        {showLastKnown && (
          <span className={styles.phNote}>
            Last known ·{" "}
            {dayMonthYear(new Date(enrollmentStatusFetchedAt!))}
          </span>
        )}
        <span className={cx(ui.pill, tone, styles.right)}>
          {view.thisCounterNominated && <Icon name="shield-check" />}
          {status}
        </span>
      </div>
      <div className={styles.ob}>
        <div className={styles.obHero}>
          <span className={cx(ui.kind, ui.kindCyan)}>
            <Icon name="shield-check" />
          </span>
          <div>
            <b>{title}</b>
            <small>
              It keeps selling if the internet goes down. A branch has one.
            </small>
          </div>
        </div>
        {view.thisCounterNominated && (
          <>
            <div className={ui.kvs}>
              {authorizedLine && (
                <div className={ui.kv}>
                  Authorized<b>{authorizedLine}</b>
                </div>
              )}
              {activatedLine && (
                <div className={ui.kv}>
                  Activated<b>{activatedLine}</b>
                </div>
              )}
              <div className={ui.kv}>
                Offline permission
                <b>
                  {expiresAt
                    ? `Until ${relativeTime(expiresAt)}`
                    : "Not received yet"}
                </b>
              </div>
              <div className={ui.kv}>
                Saved stock and prices
                <b>
                  {backup?.snapshotGeneratedAt
                    ? relativeTime(new Date(backup.snapshotGeneratedAt))
                    : "Not saved yet"}
                </b>
              </div>
              <div className={ui.kv}>
                Can sign in offline
                <b>
                  {backup
                    ? `${backup.authorizedStaff} ${backup.authorizedStaff === 1 ? "person" : "people"}`
                    : "—"}
                </b>
              </div>
            </div>
            {backup?.failure && (
              <div className={cx(ui.note, ui.noteWarn)} role="status">
                <Icon name="alert-triangle" />
                <div>
                  <b>
                    {backup.failures === 1
                      ? "The last renewal failed."
                      : `The last ${backup.failures} renewals failed.`}
                  </b>{" "}
                  {backup.failure}
                </div>
              </div>
            )}
            <p className={styles.text}>
              Renewed automatically every few minutes while someone is signed
              in here and online. Each renewal gives 24 hours.
            </p>
          </>
        )}
        {showEnrollmentAuthorizedWaiting && (
          <>
            <div className={ui.kvs}>
              {authorizedLine && (
                <div className={ui.kv}>
                  Authorized<b>{authorizedLine}</b>
                </div>
              )}
            </div>
            <p className={styles.text}>
              The owner authorized this counter to keep selling during internet
              outages. Someone allowed to activate confirms here while online.
            </p>
          </>
        )}
        {authorization && !view.thisCounterNominated && (
          <>
            <div className={ui.kvs}>
              <div className={ui.kv}>
                Authorized
                <b>
                  {authorizedLine ??
                    `On the web · ${dayMonthYear(new Date(authorization.authorizedAt))}`}
                </b>
              </div>
              <div className={ui.kv}>
                Reason<b>{authorization.reason}</b>
              </div>
            </div>
            <p className={styles.text}>
              The owner authorized this counter to keep selling during internet
              outages. Confirm here to activate it.
              {view.otherCounterNominated &&
                " The current offline counter must already be disabled and its sales recovered."}
            </p>
            <div>
              <button
                type="button"
                className={cx(ui.btn, ui.primary)}
                disabled={busy}
                onClick={() =>
                  void run(
                    () =>
                      window.pos.activateOffline({
                        authorizationId: authorization.authorizationId,
                      }),
                    setView,
                  )
                }
              >
                <Icon name="shield-check" />
                Activate as the offline backup
              </button>
            </div>
          </>
        )}
        {!authorization &&
          !view.thisCounterNominated &&
          !showEnrollmentAuthorizedWaiting &&
          !showEnrollmentNotThisCounter &&
          !showOfflineStatusUnchecked && (
            <p className={styles.text}>
              The owner authorizes one from the back office.
            </p>
          )}
        <ErrorLine error={error ?? offlineLoadError} />
        <div className={styles.offl}>
          <Icon name="info" />
          <span>
            Offline, it sells non-prescription items only. Prescriptions,
            refunds and discounts wait until it&apos;s back online.
          </span>
        </div>
        <div className={cx(styles.footN, styles.bottom)}>
          To move the backup to another counter, the owner or a delegated
          manager authorizes it on the web. Someone allowed to activate then
          confirms it at that counter while online. Only they see the Activate
          button.
        </div>
      </div>
    </div>
  );
}

function host(url: string | null) {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function ThisCounterPage({
  state,
  info,
  readiness,
  onCheck,
}: {
  state: DeviceState;
  info: AppInfo | null;
  readiness: ReadinessReport | null;
  onCheck: () => void;
}) {
  const enrollment = state.enrollment!;
  const enrolledAtDate = enrollment.enrolledAt
    ? new Date(enrollment.enrolledAt)
    : null;
  const enrolledAt = enrolledAtDate ? dayMonthYear(enrolledAtDate) : null;
  const enrollerLine = enrollment.enrolledByName
    ? ` by ${enrollment.enrolledByName}`
    : "";
  const local = atTheComputer(state);
  const server = host(state.serverUrl);
  const tillName = tillDisplayName(enrollment.counterLabel, enrollment.tillId);
  const showLastKnown =
    !enrollment.enrollmentFactsLive &&
    enrollment.enrollmentStatusFetchedAt != null;
  const branchCodeSub = enrollment.branchCode
    ? `Branch code ${enrollment.branchCode}`
    : "Sign in online once to store it here";
  const tillSub = `Till ${tillName} · one open shift at a time`;
  const enrolledSub = enrollment.enrolledByName
    ? `By ${enrollment.enrolledByName}`
    : enrolledAtDate
      ? "Enroller name not stored"
      : "Date not recorded";
  return (
    <div className={styles.page}>
      <div className={ui.pageH}>
        <div>
          <h1>This counter</h1>
          <p>
            This computer&apos;s details, readiness checks, receipt printer and
            offline backup.
          </p>
        </div>
      </div>

      <div className={ui.panel}>
        <div className={styles.shiftH}>
          <span className={cx(ui.kind, styles.heroKind)}>
            <Icon name="monitor" />
          </span>
          <div>
            <b>
              {tillName} · {enrollment.branchName}
            </b>
            <small>
              This computer is &quot;{enrollment.label}&quot;
              {enrolledAt && ` · enrolled ${enrolledAt}${enrollerLine}`}
            </small>
          </div>
          <div className={styles.headRight}>
            {showLastKnown && (
              <span className={styles.phNote}>
                Last known ·{" "}
                {dayMonthYear(new Date(enrollment.enrollmentStatusFetchedAt!))}
              </span>
            )}
            <span className={cx(ui.pill, ui.ok)}>
              <Icon name="check" />
              Enrolled
            </span>
            <span className={cx(ui.pill, local ? ui.ok : ui.bad)}>
              <Icon name="monitor" />
              {local ? "At the counter · console session" : "Remote session"}
            </span>
          </div>
        </div>
        <div className={cx(ui.tiles, styles.tiles)}>
          <div className={ui.tile}>
            <small>Branch</small>
            <b>{enrollment.branchName}</b>
            <span className={styles.tileSub}>{branchCodeSub}</span>
          </div>
          <div className={ui.tile}>
            <small>Counter and till</small>
            <b>{tillName}</b>
            <span className={styles.tileSub}>{tillSub}</span>
          </div>
          <div className={ui.tile}>
            <small>Enrolled</small>
            <b>{enrolledAt ?? "—"}</b>
            <span className={styles.tileSub}>{enrolledSub}</span>
          </div>
          <div className={ui.tile}>
            <small>App version</small>
            <b>{info?.appVersion ?? "—"}</b>
            <span className={styles.tileSub}>
              {server ? `Server ${server}` : "No server address"}
            </span>
          </div>
        </div>
      </div>

      <div className={styles.body}>
        <Readiness readiness={readiness} onCheck={onCheck} />
        <div className={styles.side}>
          <PrinterTest />
          <OfflineCounterPanel
            branchName={enrollment.branchName}
            backup={readiness?.offlineBackup ?? null}
            enrollmentBackup={enrollment.offlineBackup}
            enrollmentFactsLive={enrollment.enrollmentFactsLive}
            enrollmentStatusFetchedAt={enrollment.enrollmentStatusFetchedAt}
          />
        </div>
      </div>
    </div>
  );
}
