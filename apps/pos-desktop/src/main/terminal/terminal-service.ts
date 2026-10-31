import type {
  LocalAttendanceProofReceipt,
  LocalAttendancePurpose,
  OnlineTerminalCommand,
  TerminalCounterView,
  TerminalEnrollmentCodeChallenge,
  TerminalEnrollmentCommand,
  TerminalEnrollmentStatusView,
  TerminalIdentity,
  TerminalSessionCommand,
  TerminalStaffCredentialView,
  WindowsSessionEvidence,
  WorkSessionIdentity,
} from "@pharmaceylon/shared";
import type { ActionError, Branch, DeviceState } from "../../shared/ipc-contract";
import { ApiError, type ApiSession, type AuthUser } from "../api/api-client";
import { buildAttestation } from "../attendance/attestation";
import { DeviceKey } from "../device/device-key";
import type { DeviceStore } from "../device/device-store";
import type { Logger } from "../logging/logger";
import type { PinStore } from "../staff/pin-store";

export type TerminalServiceDeps = {
  store: DeviceStore;
  pins: PinStore;
  api: ApiSession;
  /** The server address to use before (and for) enrollment. */
  serverUrl: () => string | null;
  serverUrlEditable: boolean;
  readWindowsSession: () => WindowsSessionEvidence;
  appVersion: string;
  logger: Logger;
  now?: () => Date;
};

type StaffSession = { workSessionId: string; staffUserId: string; staffName: string; openedAt: string };

/** Plain-language explanations for refusals a person at the counter can act on. */
const MESSAGES: Record<string, string> = {
  NETWORK: "The server could not be reached. Check the internet connection and try again.",
  SERVER_NOT_SET: "Set the server address first.",
  REMOTE_SESSION_DENIED:
    "This must be done at the computer itself, not over Remote Desktop. Sign in at the counter and try again.",
  LOCAL_ATTENDANCE_UNAVAILABLE: "Windows did not confirm this is the computer's own screen. Try again at the counter.",
  TERMINAL_REVOKED: "This counter has been switched off in the back office. A manager must enroll it again.",
  PERMISSION_DENIED: "Your account is not allowed to do this at this branch.",
  IDENTITY_MISMATCH: "This counter belongs to a different branch or account.",
  CHALLENGE_EXPIRED: "That took too long. Try again.",
  CHALLENGE_INVALID: "That took too long. Try again.",
  CHALLENGE_USED_OR_EXPIRED: "That took too long. Try again.",
  ENROLLMENT_CODE_INVALID: "That code is not valid here. Check it, or ask a manager for a new one.",
  NOT_SIGNED_IN: "Sign in first.",
  HTTP_401: "Your sign-in has expired. Sign in again.",
  PIN_INCORRECT: "That PIN is not right.",
  PIN_LOCKED: "Too many wrong PINs. Wait 15 minutes or sign in with your password.",
  PIN_NOT_SET: "Set your PIN first.",
  PASSWORD_INCORRECT: "Your login password is not right.",
  LOCKED: "The counter is locked. Unlock it first.",
};

export function explain(error: unknown): ActionError {
  if (error instanceof ApiError) {
    const message = MESSAGES[error.code] ?? (error.status === 401 ? MESSAGES.HTTP_401 : error.message);
    return { code: error.code, message: message ?? "The server refused the request." };
  }
  if (error instanceof ActionFailure) return { code: error.code, message: error.message };
  return { code: "UNEXPECTED", message: "Something went wrong. Please try again." };
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
      operator: operator ? { userId: operator.id, fullName: operator.fullName, email: operator.email } : null,
      staffSession: this.staff,
      pin: this.staff && device ? this.pinState(device.identity.enrollmentId) : null,
      locked: this.locked,
      branches: operator && (!device || device.status !== "active") ? this.branches : [],
      windowsSession: { protocol: windows.protocol, remoteSession: windows.remoteSession },
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
    if (this.staff) await this.signOut("switch_user");
    else if (this.deps.api.user) await this.deps.api.logout();
    const user = await this.deps.api.login(email, password);
    try {
      let device = this.deps.store.read();
      if (device?.status === "pending") {
        await this.resolvePending(user);
        device = this.deps.store.read();
      }
      if (device && device.status === "active") {
        await this.refreshStatus();
        if (this.deps.store.read()?.status !== "active")
          throw new ActionFailure("TERMINAL_REVOKED", MESSAGES.TERMINAL_REVOKED!);
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

  async signOut(reason = "sign_out"): Promise<DeviceState> {
    const staff = this.staff;
    const device = this.deps.store.read();
    if (staff && device) {
      try {
        await this.deps.api.request("POST", `/terminals/sessions/${staff.workSessionId}/end`, {
          branchId: device.identity.branchId,
        });
      } catch (error) {
        // Offline or already superseded: the next sign-in at this till replaces the binding.
        this.deps.logger.warn("terminal.session_end_failed", { code: error instanceof ApiError ? error.code : "unknown" });
      }
      this.deps.store.recordSessionClosed(staff.workSessionId, reason, this.now());
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
      throw new ActionFailure("PIN_NOT_PREPARED", "Prepare your PIN on this counter before locking it.");
    this.locked = true;
    this.deps.logger.info("terminal.locked", { workSessionId: staff.workSessionId });
    return this.state();
  }

  /** Only the signed-in person's own PIN unlocks; anyone else signs in, which switches user. */
  unlock(pin: string): DeviceState {
    const { staff, device } = this.requireStaff(true);
    const result = this.deps.pins.check(staff.staffUserId, device.identity.enrollmentId, pin, this.now());
    if (result === "locked") throw new ActionFailure("PIN_LOCKED", MESSAGES.PIN_LOCKED!);
    if (result === "not_prepared") throw new ActionFailure("PIN_NOT_PREPARED", "Sign out and sign in with your password.");
    if (result === "wrong") throw new ActionFailure("PIN_INCORRECT", MESSAGES.PIN_INCORRECT!);
    this.locked = false;
    return this.state();
  }

  private keepVerifier(staff: StaffSession, enrollmentId: string, credential: TerminalStaffCredentialView, pin: string) {
    this.credential = credential;
    // Only a server-confirmed PIN at its current version becomes a local verifier.
    if (credential.pinSet && credential.preparedVersion === credential.pinVersion)
      this.deps.pins.save({
        staffUserId: staff.staffUserId,
        staffName: staff.staffName,
        enrollmentId,
        pinVersion: credential.pinVersion,
        pin,
        now: this.now(),
      });
  }

  private pinState(enrollmentId: string): DeviceState["pin"] {
    if (!this.staff || !this.credential) return null;
    const local = this.deps.pins.preparedVersion(this.staff.staffUserId, enrollmentId);
    return {
      set: this.credential.pinSet,
      prepared:
        this.credential.pinSet &&
        this.credential.preparedVersion === this.credential.pinVersion &&
        local === this.credential.pinVersion,
      lockedUntil: this.credential.lockedUntil === null ? null : new Date(this.credential.lockedUntil).toISOString(),
    };
  }

  private requireStaff(allowLocked = false) {
    const device = this.requireActive();
    if (!this.staff) throw new ActionFailure("NOT_SIGNED_IN", MESSAGES.NOT_SIGNED_IN!);
    if (this.locked && !allowLocked) throw new ActionFailure("LOCKED", MESSAGES.LOCKED!);
    return { staff: this.staff, device };
  }

  async listCounters(branchId: string): Promise<TerminalCounterView[]> {
    this.requireBranch(branchId);
    return this.deps.api.request<TerminalCounterView[]>("GET", "/terminals/counters", { branchId });
  }

  async createCounter(branchId: string, label: string): Promise<TerminalCounterView> {
    this.requireBranch(branchId);
    return this.deps.api.request<TerminalCounterView>("POST", "/terminals/counters", { branchId, body: { label } });
  }

  /** Enrolls this computer as one counter at one branch. The signed-in user is the enroller. */
  async enroll(input: { branchId: string; registerId: string; label: string }): Promise<DeviceState> {
    const user = this.requireOperator();
    const branch = this.requireBranch(input.branchId);
    const existing = this.deps.store.read();
    if (existing && existing.status !== "revoked" && existing.status !== "retired")
      throw new ActionFailure("ALREADY_ENROLLED", "This computer is already enrolled.");
    const apiBaseUrl = this.baseUrl();
    if (!apiBaseUrl) throw new ApiError(0, "SERVER_NOT_SET", MESSAGES.SERVER_NOT_SET!);

    const counters = await this.listCounters(branch.id);
    const counter = counters.find((c) => c.registerId === input.registerId && c.isActive);
    if (!counter) throw new ActionFailure("COUNTER_NOT_FOUND", "Choose one of this branch's counters.");
    if (counter.terminal)
      throw new ActionFailure(
        "COUNTER_OCCUPIED",
        "Another computer is already enrolled on this counter. Retire it in the back office first.",
      );

    const key = DeviceKey.generate();
    const challenge = await this.deps.api.request<TerminalEnrollmentCommand>("POST", "/terminals/enrollments/challenge", {
      branchId: branch.id,
      body: { registerId: counter.registerId, keyId: key.keyId, publicKeyHex: key.publicKeyHex, label: input.label },
    });
    return this.completeEnrollment({ key, challenge, user, branch, apiBaseUrl, counterLabel: counter.label, label: input.label });
  }

  /** Enrolls with a manager's one-time code: any staff member at the computer can do this. */
  async enrollWithCode(input: { branchId: string; code: string; label: string }): Promise<DeviceState> {
    const user = this.requireOperator();
    const branch = this.requireBranch(input.branchId);
    const existing = this.deps.store.read();
    if (existing && existing.status !== "revoked" && existing.status !== "retired")
      throw new ActionFailure("ALREADY_ENROLLED", "This computer is already enrolled.");
    const apiBaseUrl = this.baseUrl();
    if (!apiBaseUrl) throw new ApiError(0, "SERVER_NOT_SET", MESSAGES.SERVER_NOT_SET!);
    const key = DeviceKey.generate();
    const { command, counterLabel } = await this.deps.api.request<TerminalEnrollmentCodeChallenge>(
      "POST",
      "/terminals/enrollments/code-challenge",
      {
        branchId: branch.id,
        body: { code: input.code, keyId: key.keyId, publicKeyHex: key.publicKeyHex, label: input.label },
      },
    );
    return this.completeEnrollment({ key, challenge: command, user, branch, apiBaseUrl, counterLabel, label: input.label });
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
    if (challenge.publicKeyHex !== key.publicKeyHex || challenge.identity.keyId !== key.keyId)
      throw new ActionFailure("CHALLENGE_INVALID", "The server returned a challenge for a different key.");
    const proof = await this.recordAttendance(key, challenge, "enrollment", user, branch.id);

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
      await this.deps.api.request<TerminalIdentity>("POST", "/terminals/enrollments", {
        branchId: branch.id,
        body: { envelope: key.sign(challenge, "command"), attendanceProofId: proof.proofId },
      });
    } catch (error) {
      if (error instanceof ApiError && !error.uncertain) this.deps.store.discardPending();
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
    if (!device || device.status === "pending" || !this.deps.api.user) return this.state();
    const status = await this.deps.api.request<TerminalEnrollmentStatusView>(
      "GET",
      `/terminals/enrollments/${device.identity.enrollmentId}`,
      { branchId: device.identity.branchId },
    );
    this.deps.store.setStatus(status.status, this.now());
    if (status.status !== "active" && this.staff) {
      this.deps.store.recordSessionClosed(this.staff.workSessionId, "terminal_revoked", this.now());
      this.staff = null;
    }
    return this.state();
  }

  /** Signs and records an attendance proof for a signed command prepared by the server. */
  async attendCommand(command: OnlineTerminalCommand<unknown>): Promise<LocalAttendanceProofReceipt> {
    const device = this.requireActive();
    const user = this.requireOperator();
    return this.recordAttendance(this.requireKey(), command, "command", user, device.identity.branchId);
  }

  /** The signed-in staff member, their open session and this device's identity and key. */
  current(): { staff: StaffSession; identity: TerminalIdentity; key: DeviceKey } | null {
    const device = this.deps.store.read();
    if (!this.staff || !device || device.status !== "active" || this.locked) return null;
    return { staff: this.staff, identity: device.identity, key: this.requireKey() };
  }

  private async openStaffSession(user: AuthUser): Promise<void> {
    const device = this.requireActive();
    const key = this.requireKey();
    const challenge = await this.deps.api.request<TerminalSessionCommand>("POST", "/terminals/sessions/challenge", {
      branchId: device.identity.branchId,
      body: { identity: device.identity },
    });
    const fields = ["tenantId", "branchId", "terminalId", "enrollmentId", "keyId"] as const;
    if (fields.some((field) => challenge.identity[field] !== device.identity[field]))
      throw new ActionFailure("CHALLENGE_INVALID", "The server returned a challenge for a different counter.");
    const proof = await this.recordAttendance(key, challenge, "session", user, device.identity.branchId);
    const session = await this.deps.api.request<WorkSessionIdentity>("POST", "/terminals/sessions", {
      branchId: device.identity.branchId,
      body: { envelope: key.sign(challenge, "command"), attendanceProofId: proof.proofId },
    });
    const stale = this.deps.store.openSession();
    if (stale) this.deps.store.recordSessionClosed(stale.workSessionId, "superseded", this.now());
    const openedAt = this.now();
    this.deps.store.recordSessionOpened({
      workSessionId: session.workSessionId,
      staffUserId: user.id,
      staffName: user.fullName,
      enrollmentId: device.identity.enrollmentId,
      now: openedAt,
    });
    this.staff = {
      workSessionId: session.workSessionId,
      staffUserId: user.id,
      staffName: user.fullName,
      openedAt: openedAt.toISOString(),
    };
    this.locked = false;
    this.credential = await this.deps.api.request<TerminalStaffCredentialView>(
      "GET",
      `/terminals/sessions/${session.workSessionId}/credential`,
      { branchId: device.identity.branchId },
    );
    // A PIN changed or reset elsewhere makes this counter's verifier useless; drop it now.
    const local = this.deps.pins.preparedVersion(user.id, device.identity.enrollmentId);
    if (local !== null && (!this.credential.pinSet || local !== this.credential.pinVersion)) this.deps.pins.forget(user.id);
  }

  /** A pending enrollment is promoted if the server accepted it, and discarded if it did not. */
  private async resolvePending(user: AuthUser): Promise<void> {
    const device = this.deps.store.read();
    if (!device || device.status !== "pending") return;
    if (!user.branchRoles.some((r) => r.branchId === device.identity.branchId)) return;
    try {
      const status = await this.deps.api.request<TerminalEnrollmentStatusView>(
        "GET",
        `/terminals/enrollments/${device.identity.enrollmentId}`,
        { branchId: device.identity.branchId },
      );
      this.deps.store.setStatus(status.status, this.now());
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) this.deps.store.discardPending();
      else throw error;
    }
  }

  private async recordAttendance(
    key: DeviceKey,
    challenge: TerminalEnrollmentCommand | TerminalSessionCommand | OnlineTerminalCommand<unknown>,
    purpose: LocalAttendancePurpose,
    user: AuthUser,
    branchId: string,
  ): Promise<LocalAttendanceProofReceipt> {
    const windowsSession = this.deps.readWindowsSession();
    if (windowsSession.protocol !== "console" || windowsSession.remoteSession)
      throw new ActionFailure("REMOTE_SESSION_DENIED", MESSAGES.REMOTE_SESSION_DENIED!);
    const attestation = buildAttestation({
      challenge,
      purpose,
      actorUserId: user.id,
      windowsSession,
      appVersion: this.deps.appVersion,
      now: this.now().getTime(),
    });
    return this.deps.api.request<LocalAttendanceProofReceipt>("POST", "/terminals/attendance-proofs", {
      branchId,
      body: key.sign(attestation, "attendance"),
    });
  }

  private async loadBranches(): Promise<Branch[]> {
    const context = await this.deps.api.request<{
      branchRoles: { branchId: string; branch: { id: string; code?: string; name?: string } }[];
    }>("GET", "/tenant/context");
    const seen = new Map<string, Branch>();
    for (const role of context.branchRoles) {
      if (!role.branch.name || seen.has(role.branchId)) continue;
      seen.set(role.branchId, { id: role.branchId, code: role.branch.code ?? "", name: role.branch.name });
    }
    return [...seen.values()];
  }

  private requireOperator(): AuthUser {
    const user = this.deps.api.user;
    if (!user) throw new ApiError(401, "NOT_SIGNED_IN", MESSAGES.NOT_SIGNED_IN!);
    return user;
  }

  private requireBranch(branchId: string): Branch {
    this.requireOperator();
    const branch = this.branches.find((b) => b.id === branchId);
    if (!branch) throw new ActionFailure("BRANCH_NOT_AVAILABLE", "Choose one of your branches.");
    return branch;
  }

  private requireActive() {
    const device = this.deps.store.read();
    if (!device || device.status !== "active") throw new ActionFailure("NOT_ENROLLED", "This computer is not enrolled.");
    return device;
  }

  private requireKey(): DeviceKey {
    const key = this.deps.store.key();
    if (!key) throw new ActionFailure("NOT_ENROLLED", "This computer is not enrolled.");
    return key;
  }
}
