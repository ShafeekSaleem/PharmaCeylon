import { randomUUID } from "node:crypto";
import {
  offlineShiftTransition,
  type OfflineGrant,
  type OfflineCommandContext,
  type OfflineShiftCloseCommand,
  type OfflineShiftOpenCommand,
  type OfflineStaffSignIn,
  type OfflineTillShiftState,
  type TerminalErrorCode,
  type TerminalIdentity,
  type WorkSessionIdentity,
} from "@pharmaceylon/shared";
import type { CashCount, OfflineStaff } from "../../shared/ipc-contract";
import type { PosDatabase } from "../db/database";
import type { DeviceKey } from "../device/device-key";
import type { DeviceStore } from "../device/device-store";
import type { Logger } from "../logging/logger";
import type { PinStore } from "../staff/pin-store";
import { readInstalledOfflineAuthority } from "./offline-authority";
import { activeOutage } from "./offline-journal";
import type { OfflineJournalWriter } from "./offline-journal-writer";
import type { OfflineModeService, OfflineStopReason } from "./offline-mode";
import { ActionFailure } from "./terminal-service";
import type { TrustedClock } from "./trusted-clock";

/**
 * P4 #50: staff and till shifts on the nominated counter while it sells offline (D7a/D7b).
 *
 * **Signing in.** A sign-in recorded online can't back offline work: it names the server's staff
 * session rather than a shift, and the grant it cites has usually been renewed since. So once the
 * counter is offline, each person enters their PIN here. Main checks it against the verifier this
 * counter prepared online (`PinStore`, with its durable lockout), at exactly the credential version
 * the installed grant authorizes, and records a device-signed `offline_staff_sign_in` at trusted
 * time. Nobody new can be prepared, and no PIN can be set or reset, offline.
 *
 * **One work session per shift.** Offline, a shift's ID is the work session its sign-in names, and
 * every sale and the close cite it (as the server replays them). Signing in binds to the person's
 * open shift on this till, whether it opened online or offline; opening a shift takes the PIN
 * again and binds a new, locally generated work session ID to it.
 *
 * **Shifts.** Opening and closing are journal entries (`shift_open`, `shift_close`), checked with
 * the shared `offlineShiftTransition` and written in the same transaction as the counter's copy of
 * the shift (`till_shift`), so the drawer figures and the journal can't disagree. One shift is open
 * at a time; a closed shift stays closed. A prepared manager with `assist_shift_handover` closes
 * an absent cashier's shift with their own PIN, a reason and the actual count; the shift stays
 * the cashier's. Closing stays available after selling hours; opening needs them (or, later, the
 * D8 acknowledgement).
 */

export type OfflineStaffState = {
  /** Whoever signed in offline last, during this outage and under the installed grant. */
  signedIn: {
    staffUserId: string;
    staffName: string;
    signedInAt: number;
    workSessionId: string;
  } | null;
  /** People the installed grant lets work here offline who have a PIN prepared on this counter. */
  people: {
    staffUserId: string;
    staffName: string;
    canAssistClose: boolean;
    lockRemainingMs: number;
  }[];
};

/** The renderer's view: ISO times. */
export function offlineStaffForRenderer(
  state: OfflineStaffState,
): OfflineStaff {
  return {
    signedIn: state.signedIn && {
      ...state.signedIn,
      signedInAt: new Date(state.signedIn.signedInAt).toISOString(),
    },
    people: state.people.map((p) => ({
      ...p,
      lockRemainingMs: Math.max(0, Math.ceil(p.lockRemainingMs)),
    })),
  };
}

type ShiftRow = {
  work_session_id: string;
  staff_user_id: string;
  staff_name: string;
  opened_at: string;
  opening_cash_minor: number;
  state: "opening" | "open" | "closing" | "closed";
  expected_cash_minor: number;
  closed_at: string | null;
};

const MODE_MESSAGES: Record<OfflineStopReason, string> = {
  NOT_ENROLLED: "This computer is not set up as a counter.",
  TERMINAL_REVOKED: "This counter has been switched off by the back office.",
  NO_OFFLINE_AUTHORITY:
    "This counter isn't the branch's offline counter, so it can't work without a connection.",
  SNAPSHOT_STALE:
    "The saved stock was too old when the connection was lost, so this counter can't work offline.",
  GRANT_EXPIRED:
    "This counter's offline permission has ended. Reconnect to continue.",
  CLOCK_UNTRUSTED:
    "This counter can't trust its clock (Windows restarted, or it was changed). Reconnect to continue.",
  RECONCILIATION_REQUIRED:
    "This counter's offline records need to be sorted out online first.",
  SYNC_PAUSED:
    "This counter is finishing its synchronisation. Wait for the connection to come back.",
};

const POLICY_MESSAGES: Partial<Record<TerminalErrorCode, string>> = {
  BUSINESS_HOURS_ACK_REQUIRED:
    "It's outside selling hours, so a shift can't be opened offline.",
  OUTSIDE_OPERATING_HOURS: "Shifts can't be opened at this time.",
  GRANT_EXPIRED: MODE_MESSAGES.GRANT_EXPIRED,
  GRANT_INVALID:
    "This counter's offline permission isn't valid. Reconnect to continue.",
  SESSION_INVALID:
    "That doesn't match the shift on this till. Sign in again with your PIN.",
  CLOCK_UNTRUSTED: MODE_MESSAGES.CLOCK_UNTRUSTED,
};

const PIN_MESSAGES = {
  wrong: "That PIN isn't right.",
  locked:
    "Too many wrong PINs. Wait for the lock to end, or reconnect and sign in with a password.",
  not_prepared:
    "This person's PIN isn't prepared on this counter, so they can't sign in offline.",
} as const;

export type OfflineCounterDeps = {
  db: PosDatabase;
  device: Pick<DeviceStore, "read" | "key">;
  pins: Pick<PinStore, "check" | "preparedVersion" | "prepared">;
  journal: Pick<
    OfflineJournalWriter,
    | "recordOfflineStaffSignIn"
    | "activeStaffSignIn"
    | "appendSignedCommand"
    | "getHead"
  >;
  clock: Pick<TrustedClock, "stamp">;
  mode: Pick<OfflineModeService, "view">;
  logger?: Pick<Logger, "info" | "warn">;
};

type Ready = {
  enrollmentId: string;
  identity: TerminalIdentity;
  grant: OfflineGrant;
  key: DeviceKey;
  outage: { offlineSessionId: string; offlineStartedAt: number };
  trustedNow: number;
};

export class OfflineCounterService {
  constructor(private readonly deps: OfflineCounterDeps) {}

  /** Selling offline, with a verified grant, a key and trusted time — or why not. */
  private ready(): Ready {
    const view = this.deps.mode.view();
    if (view.mode !== "offline")
      throw new ActionFailure(
        view.reason ?? "ONLINE",
        view.reason
          ? MODE_MESSAGES[view.reason]
          : "The counter is online: use the normal sign-in.",
      );
    const device = this.deps.device.read();
    const key = this.deps.device.key();
    if (!device || !key)
      throw new ActionFailure("NOT_ENROLLED", MODE_MESSAGES.NOT_ENROLLED);
    const enrollmentId = device.identity.enrollmentId;
    const installed = readInstalledOfflineAuthority(this.deps.db, enrollmentId);
    const outage = activeOutage(this.deps.db, enrollmentId);
    if (!installed || !outage)
      throw new ActionFailure(
        "NO_OFFLINE_AUTHORITY",
        MODE_MESSAGES.NO_OFFLINE_AUTHORITY,
      );
    const stamp = this.deps.clock.stamp();
    if (!stamp.trusted)
      throw new ActionFailure("CLOCK_UNTRUSTED", MODE_MESSAGES.CLOCK_UNTRUSTED);
    return {
      enrollmentId,
      identity: device.identity,
      grant: installed.grant.payload,
      key,
      outage,
      trustedNow: stamp.nowMs,
    };
  }

  private staffName(enrollmentId: string, staffUserId: string): string {
    return (
      this.deps.pins
        .prepared(enrollmentId)
        .find((p) => p.staffUserId === staffUserId)?.staffName ?? ""
    );
  }

  /** The latest sign-in, if it was made offline in this outage under the installed grant. */
  private signer(
    ready: Pick<Ready, "enrollmentId" | "grant" | "outage">,
  ): OfflineStaffSignIn | null {
    const signIn = this.deps.journal.activeStaffSignIn(
      ready.enrollmentId,
    )?.payload;
    if (
      !signIn ||
      signIn.grantId !== ready.grant.grantId ||
      signIn.grantVersion !== ready.grant.grantVersion ||
      signIn.authenticatedAt < ready.outage.offlineStartedAt
    )
      return null;
    return signIn;
  }

  private requireSigner(ready: Ready): OfflineStaffSignIn {
    const signIn = this.signer(ready);
    if (!signIn)
      throw new ActionFailure("NOT_SIGNED_IN", "Sign in with your PIN first.");
    return signIn;
  }

  /** Checks a PIN here and records the sign-in, bound to `workSessionId`. */
  private authenticate(
    ready: Ready,
    staffUserId: string,
    pin: string,
    workSessionId: string,
  ): OfflineStaffSignIn {
    const staff = ready.grant.authorizedStaff.find(
      (s) => s.staffUserId === staffUserId,
    );
    if (!staff)
      throw new ActionFailure(
        "NOT_PREPARED_OFFLINE",
        "This person wasn't prepared to work at this counter offline. Reconnect to sign them in.",
      );
    const prepared = this.deps.pins.preparedVersion(
      staffUserId,
      ready.enrollmentId,
    );
    if (prepared === null)
      throw new ActionFailure("PIN_NOT_PREPARED", PIN_MESSAGES.not_prepared);
    // A PIN changed since the grant was issued: the grant vouches for the old one only.
    if (prepared !== staff.credentialVersion)
      throw new ActionFailure(
        "PIN_VERSION_MISMATCH",
        "This person's PIN changed after the counter last went online, so it can't be checked offline.",
      );
    const check = this.deps.pins.check(staffUserId, ready.enrollmentId, pin);
    if (check !== "ok")
      throw new ActionFailure(
        check === "wrong"
          ? "PIN_WRONG"
          : check === "locked"
            ? "PIN_LOCKED"
            : "PIN_NOT_PREPARED",
        PIN_MESSAGES[check],
      );
    const envelope = this.deps.journal.recordOfflineStaffSignIn({
      enrollmentId: ready.enrollmentId,
      identity: ready.identity,
      grant: ready.grant,
      session: {
        registerId: ready.grant.registerId,
        tillId: ready.grant.tillId,
        workSessionId,
        staffUserId,
      },
      staffAuthorizationId: staff.staffAuthorizationId,
      credentialVersion: staff.credentialVersion,
      authenticatedAt: ready.trustedNow,
      key: ready.key,
    });
    this.deps.logger?.info("offline.staff_signed_in", {
      staffSignInId: envelope.payload.staffSignInId,
    });
    return envelope.payload;
  }

  private shifts(enrollmentId: string): ShiftRow[] {
    return this.deps.db
      .prepare(
        `SELECT work_session_id, staff_user_id, staff_name, opened_at, opening_cash_minor, state,
                expected_cash_minor, closed_at
         FROM till_shift WHERE enrollment_id = ? ORDER BY opened_at`,
      )
      .all(enrollmentId) as ShiftRow[];
  }

  /** The till's shifts as the shared policy sees them, from the counter's own copy. */
  private tillState(ready: Ready, rows: ShiftRow[]): OfflineTillShiftState {
    const open = rows.filter((r) => r.state === "open").at(-1);
    const lastClosed = rows
      .filter((r) => r.state === "closed")
      .sort((a, b) => (a.closed_at ?? "").localeCompare(b.closed_at ?? ""))
      .at(-1);
    return {
      openShift: open
        ? {
            identity: ready.identity,
            session: this.shiftSession(ready, open),
            openedAt: Date.parse(open.opened_at),
            openingCashMinor: open.opening_cash_minor,
          }
        : null,
      expectedCashMinor: open?.expected_cash_minor ?? null,
      lastClosedWorkSessionId: lastClosed?.work_session_id ?? null,
      usedWorkSessionIds: rows.map((r) => r.work_session_id),
    };
  }

  private shiftSession(
    ready: Pick<Ready, "grant">,
    row: ShiftRow,
  ): WorkSessionIdentity {
    return {
      registerId: ready.grant.registerId,
      tillId: ready.grant.tillId,
      workSessionId: row.work_session_id,
      staffUserId: row.staff_user_id,
    };
  }

  /** A step the server hasn't confirmed (an online open or close left uncertain) holds the till. */
  private refuseUnconfirmed(rows: ShiftRow[]): void {
    if (rows.some((r) => r.state === "opening" || r.state === "closing"))
      throw new ActionFailure(
        "SHIFT_STEP_UNCONFIRMED",
        "A shift was opened or closed here just before the connection was lost, and the server never confirmed it. Reconnect first.",
      );
  }

  private context(
    ready: Ready,
    session: WorkSessionIdentity,
    signIn: OfflineStaffSignIn,
  ): OfflineCommandContext {
    const head = this.deps.journal.getHead(ready.enrollmentId);
    return {
      contractVersion: 1,
      commandId: randomUUID(),
      identity: ready.identity,
      session,
      staffSignInId: signIn.staffSignInId,
      sequence: head.sequence + 1,
      previousCommandHash: head.previousHash,
      occurredAt: ready.trustedNow,
      grantId: ready.grant.grantId,
      grantVersion: ready.grant.grantVersion,
      nominationVersion: ready.grant.nominationVersion,
      offlineSessionId: ready.outage.offlineSessionId,
      offlineStartedAt: ready.outage.offlineStartedAt,
      businessHoursAcknowledgementId: null,
    };
  }

  private checkTransition(
    ready: Ready,
    command: OfflineShiftOpenCommand | OfflineShiftCloseCommand,
    current: OfflineTillShiftState,
    signIn: OfflineStaffSignIn,
  ): void {
    const result = offlineShiftTransition(
      ready.grant,
      command,
      current,
      signIn,
      ready.trustedNow,
      "offline",
    );
    if (result.error)
      throw new ActionFailure(
        result.error,
        POLICY_MESSAGES[result.error] ?? "This can't be done offline.",
      );
  }

  // ── what the screens read ─────────────────────────────────────────────────────────────────

  /** Who is signed in offline and who could be. Local only; empty unless the counter is offline. */
  state(): OfflineStaffState {
    const device = this.deps.device.read();
    if (!device || this.deps.mode.view().mode !== "offline")
      return { signedIn: null, people: [] };
    const enrollmentId = device.identity.enrollmentId;
    const installed = readInstalledOfflineAuthority(this.deps.db, enrollmentId);
    const outage = activeOutage(this.deps.db, enrollmentId);
    if (!installed || !outage) return { signedIn: null, people: [] };
    const grant = installed.grant.payload;
    const signIn = this.signer({ enrollmentId, grant, outage });
    const authorized = new Map(
      grant.authorizedStaff.map((s) => [s.staffUserId, s]),
    );
    return {
      signedIn: signIn && {
        staffUserId: signIn.session.staffUserId,
        staffName: this.staffName(enrollmentId, signIn.session.staffUserId),
        signedInAt: signIn.authenticatedAt,
        workSessionId: signIn.session.workSessionId,
      },
      people: this.deps.pins
        .prepared(enrollmentId)
        .filter((p) => {
          const staff = authorized.get(p.staffUserId);
          return (
            staff &&
            this.deps.pins.preparedVersion(p.staffUserId, enrollmentId) ===
              staff.credentialVersion
          );
        })
        .map((p) => ({
          staffUserId: p.staffUserId,
          staffName: p.staffName,
          canAssistClose: authorized
            .get(p.staffUserId)!
            .offlineManagerActions.includes("assist_shift_handover"),
          lockRemainingMs: p.lockRemainingMs,
        })),
    };
  }

  // ── what people do ────────────────────────────────────────────────────────────────────────

  /**
   * A person signs in with their PIN. Bound to their open shift on this till if they have one;
   * otherwise to a new work session (they can't sell until a shift of theirs is open).
   */
  signIn(staffUserId: string, pin: string): OfflineStaffState {
    const ready = this.ready();
    const open = this.shifts(ready.enrollmentId).find(
      (r) => r.state === "open" && r.staff_user_id === staffUserId,
    );
    this.authenticate(
      ready,
      staffUserId,
      pin,
      open?.work_session_id ?? randomUUID(),
    );
    return this.state();
  }

  /** The signed-in person opens their shift with their PIN and the counted drawer (`shift_open`). */
  openShift(pin: string, count: CashCount): OfflineStaffState {
    const ready = this.ready();
    const person = this.requireSigner(ready).session.staffUserId;
    const rows = this.shifts(ready.enrollmentId);
    this.refuseUnconfirmed(rows);
    const open = rows.find((r) => r.state === "open");
    if (open)
      throw new ActionFailure(
        "SHIFT_ALREADY_OPEN",
        open.staff_user_id === person
          ? "Your shift is already open on this till."
          : `${open.staff_name}'s shift is still open on this till. It's counted and closed first.`,
      );
    const current = this.tillState(ready, rows);
    // A new shift, a new work session: the PIN again, and a sign-in bound to it.
    const signIn = this.authenticate(ready, person, pin, randomUUID());
    const command: OfflineShiftOpenCommand = {
      ...this.context(ready, signIn.session, signIn),
      kind: "shift_open",
      currency: "LKR",
      openingCashMinor: count.totalMinor,
      previousClosedWorkSessionId: current.lastClosedWorkSessionId,
    };
    this.checkTransition(ready, command, current, signIn);
    const envelope = ready.key.sign(command, "command");
    const at = new Date(ready.trustedNow).toISOString();
    this.deps.db.transaction(() => {
      this.deps.journal.appendSignedCommand(envelope);
      this.deps.db
        .prepare(
          `INSERT INTO till_shift (work_session_id, enrollment_id, branch_id, till_id, staff_user_id, staff_name, opened_at,
             opening_cash_minor, opening_count_json, previous_closed_work_session_id, state, expected_cash_minor, sync,
             journal_open_command_id, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, 'pending', ?, ?)`,
        )
        .run(
          signIn.session.workSessionId,
          ready.enrollmentId,
          ready.identity.branchId,
          ready.grant.tillId,
          person,
          this.staffName(ready.enrollmentId, person),
          at,
          count.totalMinor,
          JSON.stringify(count.lines),
          current.lastClosedWorkSessionId,
          count.totalMinor,
          command.commandId,
          at,
        );
    })();
    this.deps.logger?.info("offline.shift_opened", {
      workSessionId: signIn.session.workSessionId,
    });
    return this.state();
  }

  /**
   * Closes the open shift with the counted drawer (`shift_close`). The signed-in person closes
   * their own; a prepared manager closes someone else's with their PIN and a reason. The variance
   * note stays on this counter: the journal entry has no field for it.
   */
  closeShift(
    count: CashCount,
    options: {
      varianceNote?: string;
      assistance?: { pin: string; reason: string };
    } = {},
  ): OfflineStaffState {
    const ready = this.ready();
    const signer = this.requireSigner(ready);
    const person = signer.session.staffUserId;
    const rows = this.shifts(ready.enrollmentId);
    this.refuseUnconfirmed(rows);
    const open = rows.find((r) => r.state === "open");
    if (!open)
      throw new ActionFailure(
        "SHIFT_NOT_OPEN",
        "There's no open shift on this till to close.",
      );
    const assisted = open.staff_user_id !== person;
    if (assisted && !options.assistance)
      throw new ActionFailure(
        "SHIFT_ASSISTANCE_REQUIRED",
        `This is ${open.staff_name}'s shift. A manager closes it for them with their own PIN and a reason.`,
      );
    if (!assisted && options.assistance)
      throw new ActionFailure(
        "INVALID_COMMAND",
        "Your own shift closes without a manager.",
      );
    if (options.assistance && !options.assistance.reason.trim())
      throw new ActionFailure(
        "REASON_REQUIRED",
        "Say why you're closing this shift for them.",
      );
    const current = this.tillState(ready, rows);
    const session = this.shiftSession(ready, open);
    // An assisted close: the manager's PIN again, signed in under a work session of their own.
    const signIn = options.assistance
      ? this.authenticate(ready, person, options.assistance.pin, randomUUID())
      : signer;
    if (!assisted && signIn.session.workSessionId !== open.work_session_id)
      throw new ActionFailure(
        "SESSION_INVALID",
        POLICY_MESSAGES.SESSION_INVALID!,
      );
    const command: OfflineShiftCloseCommand = {
      ...this.context(ready, session, signIn),
      kind: "shift_close",
      currency: "LKR",
      closingCashCountMinor: count.totalMinor,
      expectedCashMinor: open.expected_cash_minor,
      assistance: options.assistance
        ? {
            managerSignInId: signIn.staffSignInId,
            reason: options.assistance.reason.trim(),
          }
        : null,
    };
    this.checkTransition(ready, command, current, signIn);
    const envelope = ready.key.sign(command, "command");
    const at = new Date(ready.trustedNow).toISOString();
    this.deps.db.transaction(() => {
      this.deps.journal.appendSignedCommand(envelope);
      const changed = this.deps.db
        .prepare(
          `UPDATE till_shift SET state = 'closed', sync = 'pending', error_code = NULL, error_message = NULL,
             close_command_id = ?, journal_close_command_id = ?, closing_cash_count_minor = ?, closing_count_json = ?,
             counter_expected_at_close_minor = expected_cash_minor, variance_minor = ? - expected_cash_minor,
             variance_note = ?, assistance_reason = ?, closed_by_user_id = ?, closed_by_name = ?, closed_at = ?,
             updated_at = ?
           WHERE work_session_id = ? AND state = 'open' AND expected_cash_minor = ?`,
        )
        .run(
          command.commandId,
          command.commandId,
          count.totalMinor,
          JSON.stringify(count.lines),
          count.totalMinor,
          options.varianceNote?.trim() || null,
          command.assistance?.reason ?? null,
          person,
          this.staffName(ready.enrollmentId, person),
          at,
          at,
          open.work_session_id,
          open.expected_cash_minor,
        );
      // The drawer moved between reading it and closing: nothing is written.
      if (changed.changes !== 1)
        throw new ActionFailure(
          "SHIFT_CHANGED",
          "The shift changed meanwhile. Count again.",
        );
    })();
    this.deps.logger?.info("offline.shift_closed", {
      workSessionId: open.work_session_id,
      assisted,
    });
    return this.state();
  }
}
