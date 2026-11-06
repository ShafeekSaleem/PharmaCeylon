import type {
  LocalAttendanceProofReceipt,
  OfflineActivationResult,
  OfflineAssignmentView,
  LocalAttendancePurpose,
  OnlineTerminalCommand,
  TerminalCounterView,
  TerminalEnrollmentCodeChallenge,
  TerminalEnrollmentCommand,
  TerminalEnrollmentStatusView,
  TerminalIdentity,
  TerminalPinSessionCommand,
  TerminalPinSessionRequest,
  TerminalPinSignInResult,
  TerminalSessionCommand,
  TerminalStaffCredentialView,
  WindowsSessionEvidence,
  WorkSessionIdentity,
} from "@pharmaceylon/shared";
import type {
  ActionError,
  Branch,
  DeviceState,
  OfflineCounterView,
} from "../../shared/ipc-contract";
import { ApiError, type ApiSession, type AuthUser } from "../api/api-client";
import { buildAttestation } from "../attendance/attestation";
import { detectRemoteTools } from "../attendance/remote-tools";
import { DeviceKey } from "../device/device-key";
import type { DeviceStore } from "../device/device-store";
import type { Logger } from "../logging/logger";
import type { PinStore } from "../staff/pin-store";
import type { OfflineJournalWriter } from "./offline-journal-writer";

export type TerminalServiceDeps = {
  store: DeviceStore;
  pins: PinStore;
  api: ApiSession;
  /** The server address to use before (and for) enrollment. */
  serverUrl: () => string | null;
  serverUrlEditable: boolean;
  readWindowsSession: () => WindowsSessionEvidence;
  /** Running process image names, checked for remote-control tools before any attendance proof. */
  listProcesses?: () => Promise<string[]>;
  appVersion: string;
  logger: Logger;
  now?: () => Date;
  /** P4: records durable `offline_staff_sign_in` envelopes after server-verified PIN sessions. */
  offlineJournal?: OfflineJournalWriter;
};

type StaffSession = {
  workSessionId: string;
  staffUserId: string;
  staffName: string;
  openedAt: string;
};

/** Plain-language explanations for refusals a person at the counter can act on. */
const MESSAGES: Record<string, string> = {
  NETWORK:
    "The server could not be reached. Check the internet connection and try again.",
  SERVER_NOT_SET: "Set the server address first.",
  REMOTE_SESSION_DENIED:
    "This must be done at the computer itself, not over Remote Desktop. Sign in at the counter and try again.",
  LOCAL_ATTENDANCE_UNAVAILABLE:
    "Windows did not confirm this is the computer's own screen. Try again at the counter.",
  TERMINAL_REVOKED:
    "This computer was switched off in the back office. If it was reported lost, a manager retires it in Settings → Counters & devices before enrolling it again.",
  PERMISSION_DENIED: "Your account is not allowed to do this at this branch.",
  IDENTITY_MISMATCH: "This counter belongs to a different branch or account.",
  CHALLENGE_EXPIRED: "That took too long. Try again.",
  CHALLENGE_INVALID: "That took too long. Try again.",
  CHALLENGE_USED_OR_EXPIRED: "That took too long. Try again.",
  ENROLLMENT_CODE_INVALID:
    "That code is not valid here. Check it, or ask a manager for a new one.",
  NOT_SIGNED_IN: "Sign in first.",
  HTTP_401: "Your sign-in has expired. Sign in again.",
  PIN_INCORRECT: "That PIN is not right.",
  PIN_LOCKED:
    "Too many wrong PINs. Wait 15 minutes or sign in with your password.",
  PIN_SWITCHED_OFF:
    "Too many wrong PINs. Sign in with your email and password to use your PIN again.",
  PIN_NOT_SET: "Set your PIN first.",
  PIN_NOT_PREPARED:
    "This counter isn't ready for that PIN. Sign in with your email and password, then prepare your PIN here.",
  COUNTER_SESSION_ONLY:
    "A PIN sign-in only works for selling here. Sign in with your email and password to do this.",
  PASSWORD_INCORRECT: "Your login password is not right.",
  LOCKED: "The counter is locked. Unlock it first.",
  OFFLINE_AUTHORIZATION_NOT_CURRENT:
    "That authorization is no longer current. Ask the owner to authorize this counter again.",
  D11_CLEARANCE_REQUIRED:
    "The branch's current offline counter must be disabled and its sales recovered first.",
  BRANCH_HOURS_NOT_CONFIGURED:
    "This branch's opening hours are not set up. A manager has to set the branch's hours and time zone on the web (Settings → Branches) before this can be done here.",
};

export function explain(error: unknown): ActionError {
  if (error instanceof ApiError) {
    const message =
      MESSAGES[error.code] ??
      (error.status === 401 ? MESSAGES.HTTP_401 : error.message);
    return {
      code: error.code,
      message: message ?? "The server refused the request.",
    };
  }
  if (error instanceof ActionFailure)
    return { code: error.code, message: error.message };
  return {
    code: "UNEXPECTED",
    message: "Something went wrong. Please try again.",
  };
}

export class ActionFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Enrollment and online staff sessions for this counter, entirely in the main process: it holds
 * the device key, reads the Windows session, builds attendance proofs and talks to the server.
 * The renderer only sends what a person typed (email, password, choices) and gets back state.
 */
export class TerminalService {
  private staff: StaffSession | null = null;
  private credential: TerminalStaffCredentialView | null = null;
  private locked = false;
  private branches: Branch[] = [];
  /** People the server refused for a locked PIN here, until about when the lock ends. */
  private readonly serverPinLocks = new Map<string, number>();
  /** People whose PIN the server has switched off, until they sign in here with their password. */
  private readonly serverPinsOff = new Set<string>();
  private readonly now: () => Date;

  constructor(private readonly deps: TerminalServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  state(): DeviceState {
    const device = this.deps.store.read();
    const operator = this.deps.api.user;
    const windows = this.deps.readWindowsSession();
    return {
      serverUrl: device?.apiBaseUrl ?? this.deps.serverUrl(),
      serverUrlEditable: this.deps.serverUrlEditable && !device,
      enrollment: device
        ? {
            status: device.status,
            branchName: device.branchName,
            counterLabel: device.counterLabel,
            label: device.label,
            terminalId: device.identity.terminalId,
            enrollmentId: device.identity.enrollmentId,
            enrolledAt: device.enrolledAt,
          }
        : null,
      operator: operator
        ? {
            userId: operator.id,
            fullName: operator.fullName,
            email: operator.email,
          }
        : null,
      staffSession: this.staff,
      pin:
        this.staff && device
          ? this.pinState(device.identity.enrollmentId)
          : null,
      locked: this.locked,
      counterStaff:
        device?.status === "active"
          ? this.counterStaff(device.identity.enrollmentId)
          : [],
      branches:
        operator && (!device || device.status !== "active")
          ? this.branches
          : [],
      windowsSession: {
        protocol: windows.protocol,
        remoteSession: windows.remoteSession,
      },
    };
  }

  private baseUrl(): string | null {
    return this.deps.store.read()?.apiBaseUrl ?? this.deps.serverUrl();
  }

  /**
   * Signs a person in. On an active counter that opens their staff session; on a counter that is
   * not enrolled yet it only signs in, so a manager can enroll it.
   */
  async signIn(email: string, password: string): Promise<DeviceState> {
    // Check the new person first: a wrong password must not end the current session.
    const login = await this.deps.api.authenticate(email, password);
    if (this.staff) await this.signOut("switch_user");
    else if (this.deps.api.user) await this.deps.api.logout();
    const user = this.deps.api.adopt(login);
    // The server takes a right password as the end of any lock on their PIN.
    this.serverPinLocks.delete(user.id);
    this.serverPinsOff.delete(user.id);
    try {
      let device = this.deps.store.read();
      if (device?.status === "pending") {
        await this.resolvePending(user);
        device = this.deps.store.read();
      }
      if (device && device.status === "active") {
        await this.refreshStatus();
        if (this.deps.store.read()?.status !== "active")
          throw new ActionFailure(
            "TERMINAL_REVOKED",
            MESSAGES.TERMINAL_REVOKED!,
          );
        await this.openStaffSession(user);
      } else {
        this.branches = await this.loadBranches();
      }
    } catch (error) {
      if (!this.staff) await this.deps.api.logout();
      throw error;
    }
    return this.state();
  }

  /**
   * D-W5: signs a person prepared on this counter in with their PIN. The server checks the PIN
   * (and its lockout) against its own verifier; the device key and a console attendance proof
   * stand in for the password. The login it returns works only at this counter. The signed-in
   * person's own PIN just unlocks, locally, so that keeps working offline.
   */
  async signInWithPin(staffUserId: string, pin: string): Promise<DeviceState> {
    if (this.staff?.staffUserId === staffUserId) return this.unlock(pin);
    const device = this.requireActive();
    const key = this.requireKey();
    const { enrollmentId } = device.identity;
    if (this.deps.pins.preparedVersion(staffUserId, enrollmentId) === null)
      throw new ActionFailure("PIN_NOT_PREPARED", MESSAGES.PIN_NOT_PREPARED!);
    const windowsSession = this.requireConsole();
    await this.refuseRemoteTools();
    const request: TerminalPinSessionRequest = {
      contractVersion: 1,
      kind: "terminal_pin_session_request",
      identity: device.identity,
      staffUserId,
    };
    let result: TerminalPinSignInResult;
    try {
      const challenge =
        await this.deps.api.requestWithoutToken<TerminalPinSessionCommand>(
          "POST",
          "/terminals/pin-sessions/challenge",
          key.sign(request, "command"),
        );
      if (
        !this.sameIdentity(challenge.identity, device.identity) ||
        challenge.session.staffUserId !== staffUserId
      )
        throw new ActionFailure(
          "CHALLENGE_INVALID",
          "The server returned a challenge for a different counter.",
        );
      const attestation = buildAttestation({
        challenge,
        purpose: "pin_session",
        actorUserId: staffUserId,
        windowsSession,
        appVersion: this.deps.appVersion,
        now: this.now().getTime(),
      });
      result = await this.deps.api.requestWithoutToken<TerminalPinSignInResult>(
        "POST",
        "/terminals/pin-sessions",
        {
          envelope: key.sign(challenge, "command"),
          attendance: key.sign(attestation, "attendance"),
          pin,
        },
      );
    } catch (error) {
      if (error instanceof ApiError) {
        // A PIN changed or reset elsewhere, or the person may no longer work here: this counter's
        // verifier is no use any more, so they stop being offered.
        if (
          error.code === "PIN_NOT_PREPARED" ||
          error.code === "PIN_NOT_SET" ||
          error.code === "PERMISSION_DENIED"
        )
          this.deps.pins.forget(staffUserId);
        // The server says when its lock ends; it may have started at another counter.
        const lockedUntil = Date.parse(String(error.body.lockedUntil));
        if (error.code === "PIN_LOCKED" && lockedUntil > this.now().getTime())
          this.serverPinLocks.set(staffUserId, lockedUntil);
        if (error.code === "PIN_SWITCHED_OFF")
          this.serverPinsOff.add(staffUserId);
      }
      throw error;
    }
    this.serverPinLocks.delete(staffUserId);
    this.serverPinsOff.delete(staffUserId);
    // The new person is confirmed, and the server has already superseded whoever was here.
    if (this.staff)
      this.deps.store.recordSessionClosed(
        this.staff.workSessionId,
        "switch_user",
        this.now(),
      );
    if (this.deps.api.user) await this.deps.api.logout();
    this.staff = null;
    this.credential = null;
    const user = this.deps.api.adopt({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      user: result.user,
    });
    await this.adoptSession(user, result.session.workSessionId);
    // The server just confirmed this PIN at its current version here: refresh the verifier,
    // which also clears any local lockout.
    this.keepVerifier(this.staff!, enrollmentId, this.credential!, pin);
    try {
      this.deps.offlineJournal?.recordStaffSignInFromPin({
        enrollmentId,
        identity: device.identity,
        registerId: device.registerId,
        tillId: device.tillId,
        session: result.session,
        key: this.requireKey(),
      });
    } catch (error) {
      this.deps.logger.warn("offline_journal.staff_sign_in_failed", {
        error: error instanceof Error ? error.message : "unknown",
      });
    }
    return this.state();
  }

  private counterStaff(enrollmentId: string): DeviceState["counterStaff"] {
    const now = this.now().getTime();
    return this.deps.pins.prepared(enrollmentId).map((person) => {
      const serverLock = this.serverPinLocks.get(person.staffUserId) ?? 0;
      const signedIn = this.staff?.staffUserId === person.staffUserId;
      const lockEnds = Math.max(now + person.lockRemainingMs, serverLock);
      const pinOff = this.serverPinsOff.has(person.staffUserId);
      const locked = !pinOff && lockEnds > now;
      return {
        staffUserId: person.staffUserId,
        staffName: person.staffName,
        role: person.role,
        state: signedIn
          ? "signed_in"
          : pinOff
            ? "pin_off"
            : locked
              ? "locked"
              : "ready",
        lockedUntil: locked ? new Date(lockEnds).toISOString() : null,
      };
    });
  }

  async signOut(reason = "sign_out"): Promise<DeviceState> {
    const staff = this.staff;
    const device = this.deps.store.read();
    if (staff && device) {
      try {
        await this.deps.api.request(
          "POST",
          `/terminals/sessions/${staff.workSessionId}/end`,
          {
            branchId: device.identity.branchId,
          },
        );
      } catch (error) {
        // Offline or already superseded: the next sign-in at this till replaces the binding.
        this.deps.logger.warn("terminal.session_end_failed", {
          code: error instanceof ApiError ? error.code : "unknown",
        });
      }
      this.deps.store.recordSessionClosed(
        staff.workSessionId,
        reason,
        this.now(),
      );
    }
    this.staff = null;
    this.credential = null;
    this.locked = false;
    this.branches = [];
    await this.deps.api.logout();
    return this.state();
  }

  /** Sets or changes the signed-in person's own PIN, here, with their login password. */
  async setPin(pin: string, password: string): Promise<DeviceState> {
    const { staff, device } = this.requireStaff();
    const credential = await this.deps.api.request<TerminalStaffCredentialView>(
      "POST",
      `/terminals/sessions/${staff.workSessionId}/pin`,
      { branchId: device.identity.branchId, body: { pin, password } },
    );
    this.keepVerifier(staff, device.identity.enrollmentId, credential, pin);
    return this.state();
  }

  /** Enters the PIN once here while online, so this counter can check it later without the server. */
  async preparePin(pin: string): Promise<DeviceState> {
    const { staff, device } = this.requireStaff();
    const credential = await this.deps.api.request<TerminalStaffCredentialView>(
      "POST",
      `/terminals/sessions/${staff.workSessionId}/prepare`,
      { branchId: device.identity.branchId, body: { pin } },
    );
    this.keepVerifier(staff, device.identity.enrollmentId, credential, pin);
    return this.state();
  }

  /** Hides the counter behind the signed-in person's PIN without ending their session. */
  lock(): DeviceState {
    const { staff, device } = this.requireStaff(true);
    if (this.pinState(device.identity.enrollmentId)?.prepared !== true)
      throw new ActionFailure(
        "PIN_NOT_PREPARED",
        "Prepare your PIN on this counter before locking it.",
      );
    this.locked = true;
    this.deps.logger.info("terminal.locked", {
      workSessionId: staff.workSessionId,
    });
    return this.state();
  }

  /** Only the signed-in person's own PIN unlocks; anyone else signs in, which switches user. */
  unlock(pin: string): DeviceState {
    const { staff, device } = this.requireStaff(true);
    const result = this.deps.pins.check(
      staff.staffUserId,
      device.identity.enrollmentId,
      pin,
    );
    if (result === "locked")
      throw new ActionFailure("PIN_LOCKED", MESSAGES.PIN_LOCKED!);
    if (result === "not_prepared")
      throw new ActionFailure(
        "PIN_NOT_PREPARED",
        "Sign out and sign in with your password.",
      );
    if (result === "wrong")
      throw new ActionFailure("PIN_INCORRECT", MESSAGES.PIN_INCORRECT!);
    this.locked = false;
    return this.state();
  }

  private keepVerifier(
    staff: StaffSession,
    enrollmentId: string,
    credential: TerminalStaffCredentialView,
    pin: string,
  ) {
    this.credential = credential;
    // Only a server-confirmed PIN at its current version becomes a local verifier.
    if (
      credential.pinSet &&
      credential.preparedVersion === credential.pinVersion
    )
      this.deps.pins.save({
        staffUserId: staff.staffUserId,
        staffName: staff.staffName,
        role: this.roleHere(),
        enrollmentId,
        pinVersion: credential.pinVersion,
        pin,
        now: this.now(),
      });
  }

  /** The signed-in person's role at this counter's branch, for the lock screen. */
  private roleHere(): string | null {
    const branchId = this.deps.store.read()?.identity.branchId;
    return (
      this.deps.api.user?.branchRoles.find((r) => r.branchId === branchId)
        ?.role ?? null
    );
  }

  private pinState(enrollmentId: string): DeviceState["pin"] {
    if (!this.staff || !this.credential) return null;
    const local = this.deps.pins.preparedVersion(
      this.staff.staffUserId,
      enrollmentId,
    );
    return {
      set: this.credential.pinSet,
      prepared:
        this.credential.pinSet &&
        this.credential.preparedVersion === this.credential.pinVersion &&
        local === this.credential.pinVersion,
      lockedUntil:
        this.credential.lockedUntil === null
          ? null
          : new Date(this.credential.lockedUntil).toISOString(),
    };
  }

  private requireStaff(allowLocked = false) {
    const device = this.requireActive();
    if (!this.staff)
      throw new ActionFailure("NOT_SIGNED_IN", MESSAGES.NOT_SIGNED_IN!);
    if (this.locked && !allowLocked)
      throw new ActionFailure("LOCKED", MESSAGES.LOCKED!);
    return { staff: this.staff, device };
  }

  async listCounters(branchId: string): Promise<TerminalCounterView[]> {
    this.requireBranch(branchId);
    return this.deps.api.request<TerminalCounterView[]>(
      "GET",
      "/terminals/counters",
      { branchId },
    );
  }

  async createCounter(
    branchId: string,
    label: string,
  ): Promise<TerminalCounterView> {
    this.requireBranch(branchId);
    return this.deps.api.request<TerminalCounterView>(
      "POST",
      "/terminals/counters",
      { branchId, body: { label } },
    );
  }

  /** Enrolls this computer as one counter at one branch. The signed-in user is the enroller. */
  async enroll(input: {
    branchId: string;
    registerId: string;
    label: string;
  }): Promise<DeviceState> {
    const user = this.requireOperator();
    const branch = this.requireBranch(input.branchId);
    const existing = this.deps.store.read();
    if (
      existing &&
      existing.status !== "revoked" &&
      existing.status !== "retired"
    )
      throw new ActionFailure(
        "ALREADY_ENROLLED",
        "This computer is already enrolled.",
      );
    const apiBaseUrl = this.baseUrl();
    if (!apiBaseUrl)
      throw new ApiError(0, "SERVER_NOT_SET", MESSAGES.SERVER_NOT_SET!);

    const counters = await this.listCounters(branch.id);
    const counter = counters.find(
      (c) => c.registerId === input.registerId && c.isActive,
    );
    if (!counter)
      throw new ActionFailure(
        "COUNTER_NOT_FOUND",
        "Choose one of this branch's counters.",
      );
    if (counter.terminal)
      throw new ActionFailure(
        "COUNTER_OCCUPIED",
        "Another computer is already enrolled on this counter. Retire it in the back office first.",
      );

    const key = DeviceKey.generate();
    const challenge = await this.deps.api.request<TerminalEnrollmentCommand>(
      "POST",
      "/terminals/enrollments/challenge",
      {
        branchId: branch.id,
        body: {
          registerId: counter.registerId,
          keyId: key.keyId,
          publicKeyHex: key.publicKeyHex,
          label: input.label,
        },
      },
    );
    return this.completeEnrollment({
      key,
      challenge,
      user,
      branch,
      apiBaseUrl,
      counterLabel: counter.label,
      label: input.label,
    });
  }

  /** Enrolls with a manager's one-time code: any staff member at the computer can do this. */
  async enrollWithCode(input: {
    branchId: string;
    code: string;
    label: string;
  }): Promise<DeviceState> {
    const user = this.requireOperator();
    const branch = this.requireBranch(input.branchId);
    const existing = this.deps.store.read();
    if (
      existing &&
      existing.status !== "revoked" &&
      existing.status !== "retired"
    )
      throw new ActionFailure(
        "ALREADY_ENROLLED",
        "This computer is already enrolled.",
      );
    const apiBaseUrl = this.baseUrl();
    if (!apiBaseUrl)
      throw new ApiError(0, "SERVER_NOT_SET", MESSAGES.SERVER_NOT_SET!);
    const key = DeviceKey.generate();
    const { command, counterLabel } =
      await this.deps.api.request<TerminalEnrollmentCodeChallenge>(
        "POST",
        "/terminals/enrollments/code-challenge",
        {
          branchId: branch.id,
          body: {
            code: input.code,
            keyId: key.keyId,
            publicKeyHex: key.publicKeyHex,
            label: input.label,
          },
        },
      );
    return this.completeEnrollment({
      key,
      challenge: command,
      user,
      branch,
      apiBaseUrl,
      counterLabel,
      label: input.label,
    });
  }

  private async completeEnrollment(input: {
    key: DeviceKey;
    challenge: TerminalEnrollmentCommand;
    user: AuthUser;
    branch: Branch;
    apiBaseUrl: string;
    counterLabel: string;
    label: string;
  }): Promise<DeviceState> {
    const { key, challenge, user, branch, apiBaseUrl } = input;
    if (
      challenge.publicKeyHex !== key.publicKeyHex ||
      challenge.identity.keyId !== key.keyId
    )
      throw new ActionFailure(
        "CHALLENGE_INVALID",
        "The server returned a challenge for a different key.",
      );
    const proof = await this.recordAttendance(
      key,
      challenge,
      "enrollment",
      user,
      branch.id,
    );

    // Saved before finishing, so the key survives a crash or a lost response.
    this.deps.store.savePending({
      apiBaseUrl,
      identity: challenge.identity,
      branchName: branch.name,
      registerId: challenge.registerId,
      tillId: challenge.tillId,
      counterLabel: input.counterLabel,
      label: input.label,
      key,
      enrolledByUserId: user.id,
      now: this.now(),
    });
    try {
      await this.deps.api.request<TerminalIdentity>(
        "POST",
        "/terminals/enrollments",
        {
          branchId: branch.id,
          body: {
            envelope: key.sign(challenge, "command"),
            attendanceProofId: proof.proofId,
          },
        },
      );
    } catch (error) {
      if (error instanceof ApiError && !error.uncertain)
        this.deps.store.discardPending();
      throw error;
    }
    this.deps.store.setStatus("active", this.now());
    this.deps.logger.info("terminal.enrolled", {
      terminalId: challenge.identity.terminalId,
      enrollmentId: challenge.identity.enrollmentId,
    });
    // The enroller does not stay signed in: the counter starts at the staff sign-in screen.
    await this.signOut("enrolled");
    return this.state();
  }

  /** Asks the server whether this enrollment still stands and records the answer. */
  async refreshStatus(): Promise<DeviceState> {
    const device = this.deps.store.read();
    if (!device || device.status === "pending" || !this.deps.api.user)
      return this.state();
    const status = await this.deps.api.request<TerminalEnrollmentStatusView>(
      "GET",
      `/terminals/enrollments/${device.identity.enrollmentId}`,
      { branchId: device.identity.branchId },
    );
    this.deps.store.setStatus(status.status, this.now());
    if (status.status !== "active" && this.staff) {
      this.deps.store.recordSessionClosed(
        this.staff.workSessionId,
        "terminal_revoked",
        this.now(),
      );
      this.staff = null;
    }
    return this.state();
  }

  /** Signs and records an attendance proof for a signed command prepared by the server. */
  async attendCommand(
    command: OnlineTerminalCommand<unknown>,
  ): Promise<LocalAttendanceProofReceipt> {
    const device = this.requireActive();
    const user = this.requireOperator();
    return this.recordAttendance(
      this.requireKey(),
      command,
      "command",
      user,
      device.identity.branchId,
    );
  }

  /** Go-live evidence: the signed-in person confirms the test receipt came out of this printer. */
  async confirmTestReceipt(
    printerName: string,
  ): Promise<{ confirmedAt: string }> {
    const { staff, device } = this.requireStaff();
    const result = await this.deps.api.request<{
      testReceiptId: string;
      confirmedAt: number;
    }>("POST", `/terminals/sessions/${staff.workSessionId}/test-receipt`, {
      branchId: device.identity.branchId,
      body: { printerName },
    });
    return { confirmedAt: new Date(result.confirmedAt).toISOString() };
  }

  /** Whether this counter is the branch's offline counter, or has an authorization waiting. */
  async offlineCounter(): Promise<OfflineCounterView> {
    const { device } = this.requireStaff();
    const view = await this.deps.api.request<OfflineAssignmentView>(
      "GET",
      "/terminals/offline-assignment",
      {
        branchId: device.identity.branchId,
      },
    );
    const waiting = view.authorizations.find(
      (a) =>
        a.status === "authorized" &&
        a.targetEnrollmentId === device.identity.enrollmentId,
    );
    return {
      thisCounterNominated:
        view.nomination?.enrollmentId === device.identity.enrollmentId,
      otherCounterNominated:
        view.nomination !== null &&
        view.nomination.enrollmentId !== device.identity.enrollmentId,
      nominationVersion: view.nominationVersion,
      authorization: waiting
        ? {
            authorizationId: waiting.authorizationId,
            expectedNominationVersion: waiting.expectedNominationVersion,
            reason: waiting.reason,
            authorizedAt: new Date(waiting.authorizedAt).toISOString(),
          }
        : null,
    };
  }

  /** Revised D13 step 2: confirm, here, the owner's or delegated manager's authorization. */
  async activateOffline(authorizationId: string): Promise<OfflineCounterView> {
    const { staff, device } = this.requireStaff();
    const user = this.requireOperator();
    const current = await this.offlineCounter();
    if (
      !current.authorization ||
      current.authorization.authorizationId !== authorizationId
    )
      throw new ActionFailure(
        "OFFLINE_AUTHORIZATION_NOT_CURRENT",
        MESSAGES.OFFLINE_AUTHORIZATION_NOT_CURRENT!,
      );
    const command = await this.deps.api.request<OnlineTerminalCommand<unknown>>(
      "POST",
      "/terminals/offline-assignment/activate/challenge",
      {
        branchId: device.identity.branchId,
        body: {
          workSessionId: staff.workSessionId,
          authorizationId,
          expectedNominationVersion:
            current.authorization.expectedNominationVersion,
        },
      },
    );
    const key = this.requireKey();
    const proof = await this.recordAttendance(
      key,
      command,
      "command",
      user,
      device.identity.branchId,
    );
    const result = await this.deps.api.request<OfflineActivationResult>(
      "POST",
      "/terminals/offline-assignment/activate",
      {
        branchId: device.identity.branchId,
        body: {
          envelope: key.sign(command, "command"),
          attendanceProofId: proof.proofId,
        },
      },
    );
    this.deps.logger.info("terminal.offline_activated", {
      nominationVersion: result.nominationVersion,
    });
    return this.offlineCounter();
  }

  /** The signed-in staff member, their open session and this device's identity and key. */
  current(): {
    staff: StaffSession;
    identity: TerminalIdentity;
    key: DeviceKey;
  } | null {
    const device = this.deps.store.read();
    if (!this.staff || !device || device.status !== "active" || this.locked)
      return null;
    return {
      staff: this.staff,
      identity: device.identity,
      key: this.requireKey(),
    };
  }

  private async openStaffSession(user: AuthUser): Promise<void> {
    const device = this.requireActive();
    const key = this.requireKey();
    const challenge = await this.deps.api.request<TerminalSessionCommand>(
      "POST",
      "/terminals/sessions/challenge",
      {
        branchId: device.identity.branchId,
        body: { identity: device.identity },
      },
    );
    if (!this.sameIdentity(challenge.identity, device.identity))
      throw new ActionFailure(
        "CHALLENGE_INVALID",
        "The server returned a challenge for a different counter.",
      );
    const proof = await this.recordAttendance(
      key,
      challenge,
      "session",
      user,
      device.identity.branchId,
    );
    const session = await this.deps.api.request<WorkSessionIdentity>(
      "POST",
      "/terminals/sessions",
      {
        branchId: device.identity.branchId,
        body: {
          envelope: key.sign(challenge, "command"),
          attendanceProofId: proof.proofId,
        },
      },
    );
    await this.adoptSession(user, session.workSessionId);
  }

  /** Makes a session the server just opened this counter's own: recorded, unlocked, PIN known. */
  private async adoptSession(
    user: AuthUser,
    workSessionId: string,
  ): Promise<void> {
    const device = this.requireActive();
    const stale = this.deps.store.openSession();
    if (stale)
      this.deps.store.recordSessionClosed(
        stale.workSessionId,
        "superseded",
        this.now(),
      );
    const openedAt = this.now();
    this.deps.store.recordSessionOpened({
      workSessionId,
      staffUserId: user.id,
      staffName: user.fullName,
      enrollmentId: device.identity.enrollmentId,
      now: openedAt,
    });
    this.staff = {
      workSessionId,
      staffUserId: user.id,
      staffName: user.fullName,
      openedAt: openedAt.toISOString(),
    };
    this.locked = false;
    this.credential = await this.deps.api.request<TerminalStaffCredentialView>(
      "GET",
      `/terminals/sessions/${workSessionId}/credential`,
      { branchId: device.identity.branchId },
    );
    // A PIN changed or reset elsewhere makes this counter's verifier useless; drop it now.
    const local = this.deps.pins.preparedVersion(
      user.id,
      device.identity.enrollmentId,
    );
    if (
      local !== null &&
      (!this.credential.pinSet || local !== this.credential.pinVersion)
    )
      this.deps.pins.forget(user.id);
  }

  private sameIdentity(a: TerminalIdentity, b: TerminalIdentity): boolean {
    const fields = [
      "tenantId",
      "branchId",
      "terminalId",
      "enrollmentId",
      "keyId",
    ] as const;
    return fields.every((field) => a[field] === b[field]);
  }

  /** Attendance needs the computer's own screen; say so before asking the server. */
  private requireConsole(): WindowsSessionEvidence {
    const windowsSession = this.deps.readWindowsSession();
    if (windowsSession.protocol !== "console" || windowsSession.remoteSession)
      throw new ActionFailure(
        "REMOTE_SESSION_DENIED",
        MESSAGES.REMOTE_SESSION_DENIED!,
      );
    return windowsSession;
  }

  /** A pending enrollment is promoted if the server accepted it, and discarded if it did not. */
  private async resolvePending(user: AuthUser): Promise<void> {
    const device = this.deps.store.read();
    if (!device || device.status !== "pending") return;
    if (!user.branchRoles.some((r) => r.branchId === device.identity.branchId))
      return;
    try {
      const status = await this.deps.api.request<TerminalEnrollmentStatusView>(
        "GET",
        `/terminals/enrollments/${device.identity.enrollmentId}`,
        { branchId: device.identity.branchId },
      );
      this.deps.store.setStatus(status.status, this.now());
    } catch (error) {
      if (error instanceof ApiError && error.status === 404)
        this.deps.store.discardPending();
      else throw error;
    }
  }

  /**
   * Remote-control tools drive the console session, so Windows can't tell them from someone at the
   * counter. Refusing while a known one runs stops the casual remote approval; it is not a security
   * boundary (a renamed process passes), which the accepted v1 limits record. If the process list
   * can't be read, this proceeds: the check narrows a risk, it doesn't decide attendance.
   */
  private async refuseRemoteTools(): Promise<void> {
    if (!this.deps.listProcesses) return;
    let images: string[];
    try {
      images = await this.deps.listProcesses();
    } catch (error) {
      this.deps.logger.warn("attendance.process_list_failed", {
        error: error instanceof Error ? error.message : "unknown",
      });
      return;
    }
    const tools = detectRemoteTools(images);
    if (tools.length)
      throw new ActionFailure(
        "REMOTE_TOOL_RUNNING",
        `${tools.join(" and ")} ${tools.length === 1 ? "is" : "are"} running on this computer. Close ${tools.length === 1 ? "it" : "them"} and try again at the counter.`,
      );
  }

  private async recordAttendance(
    key: DeviceKey,
    challenge:
      | TerminalEnrollmentCommand
      | TerminalSessionCommand
      | OnlineTerminalCommand<unknown>,
    purpose: LocalAttendancePurpose,
    user: AuthUser,
    branchId: string,
  ): Promise<LocalAttendanceProofReceipt> {
    const windowsSession = this.requireConsole();
    await this.refuseRemoteTools();
    const attestation = buildAttestation({
      challenge,
      purpose,
      actorUserId: user.id,
      windowsSession,
      appVersion: this.deps.appVersion,
      now: this.now().getTime(),
    });
    return this.deps.api.request<LocalAttendanceProofReceipt>(
      "POST",
      "/terminals/attendance-proofs",
      {
        branchId,
        body: key.sign(attestation, "attendance"),
      },
    );
  }

  private async loadBranches(): Promise<Branch[]> {
    const context = await this.deps.api.request<{
      branchRoles: {
        branchId: string;
        branch: { id: string; code?: string; name?: string };
      }[];
    }>("GET", "/tenant/context");
    const seen = new Map<string, Branch>();
    for (const role of context.branchRoles) {
      if (!role.branch.name || seen.has(role.branchId)) continue;
      seen.set(role.branchId, {
        id: role.branchId,
        code: role.branch.code ?? "",
        name: role.branch.name,
      });
    }
    return [...seen.values()];
  }

  private requireOperator(): AuthUser {
    const user = this.deps.api.user;
    if (!user)
      throw new ApiError(401, "NOT_SIGNED_IN", MESSAGES.NOT_SIGNED_IN!);
    return user;
  }

  private requireBranch(branchId: string): Branch {
    this.requireOperator();
    const branch = this.branches.find((b) => b.id === branchId);
    if (!branch)
      throw new ActionFailure(
        "BRANCH_NOT_AVAILABLE",
        "Choose one of your branches.",
      );
    return branch;
  }

  private requireActive() {
    const device = this.deps.store.read();
    if (!device || device.status !== "active")
      throw new ActionFailure("NOT_ENROLLED", "This computer is not enrolled.");
    return device;
  }

  private requireKey(): DeviceKey {
    const key = this.deps.store.key();
    if (!key)
      throw new ActionFailure("NOT_ENROLLED", "This computer is not enrolled.");
    return key;
  }
}
