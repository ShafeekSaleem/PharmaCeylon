import { z } from "zod";

/**
 * The whole renderer ↔ main surface. Every channel is declared here with a
 * validator for what goes in and what comes back; the preload bridge and the
 * main-process handlers are both generated from this one table, so there is no
 * channel the renderer can reach that is not listed and validated.
 */

export const checkStatusSchema = z.enum(["ok", "warning", "failed", "not_ready"]);
export type CheckStatus = z.infer<typeof checkStatusSchema>;

export const readinessCheckSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: checkStatusSchema,
  detail: z.string(),
});
export type ReadinessCheck = z.infer<typeof readinessCheckSchema>;

export const readinessReportSchema = z.object({
  ready: z.boolean(),
  checkedAt: z.string(),
  checks: z.array(readinessCheckSchema),
});
export type ReadinessReport = z.infer<typeof readinessReportSchema>;

export const appInfoSchema = z.object({
  appVersion: z.string(),
  electronVersion: z.string(),
  schemaVersion: z.number().int(),
  packaged: z.boolean(),
});
export type AppInfo = z.infer<typeof appInfoSchema>;

/**
 * Deliberately not "online": the spec reserves that word for a reachable API
 * *and* a successful push/pull cycle, and there is no sync engine yet.
 */
export const apiReachabilitySchema = z.object({
  reachable: z.boolean(),
  checkedAt: z.string(),
  latencyMs: z.number().nullable(),
});
export type ApiReachability = z.infer<typeof apiReachabilitySchema>;

export const printerSchema = z.object({
  name: z.string(),
  displayName: z.string(),
});
export type Printer = z.infer<typeof printerSchema>;

export const printResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
});
export type PrintResult = z.infer<typeof printResultSchema>;

const uuid = z.string().uuid();

export const branchSchema = z.object({ id: uuid, code: z.string(), name: z.string() });
export type Branch = z.infer<typeof branchSchema>;

export const counterSchema = z.object({
  registerId: uuid,
  tillId: uuid,
  label: z.string(),
  isActive: z.boolean(),
  terminal: z
    .object({
      terminalId: uuid,
      label: z.string(),
      enrollmentId: uuid.nullable(),
      enrolledAt: z.number().nullable(),
    })
    .nullable(),
});
export type Counter = z.infer<typeof counterSchema>;

/** What the renderer may know about this counter. Never keys, tokens, proofs or signatures. */
export const deviceStateSchema = z.object({
  serverUrl: z.string().nullable(),
  serverUrlEditable: z.boolean(),
  enrollment: z
    .object({
      status: z.enum(["pending", "active", "revoked", "retired"]),
      branchName: z.string(),
      counterLabel: z.string(),
      label: z.string(),
      terminalId: uuid,
      enrollmentId: uuid,
      enrolledAt: z.string().nullable(),
    })
    .nullable(),
  operator: z.object({ userId: uuid, fullName: z.string(), email: z.string() }).nullable(),
  staffSession: z
    .object({ workSessionId: uuid, staffUserId: uuid, staffName: z.string(), openedAt: z.string() })
    .nullable(),
  /** The signed-in person's PIN on this counter; null when nobody is signed in. */
  pin: z.object({ set: z.boolean(), prepared: z.boolean(), lockedUntil: z.string().nullable() }).nullable(),
  locked: z.boolean(),
  branches: z.array(branchSchema),
  windowsSession: z.object({ protocol: z.enum(["console", "rdp", "unknown"]), remoteSession: z.boolean() }),
});
export type DeviceState = z.infer<typeof deviceStateSchema>;

export const offlineCounterSchema = z.object({
  thisCounterNominated: z.boolean(),
  otherCounterNominated: z.boolean(),
  nominationVersion: z.number().int().min(0),
  authorization: z
    .object({
      authorizationId: uuid,
      expectedNominationVersion: z.number().int().min(0),
      reason: z.string(),
      authorizedAt: z.string(),
    })
    .nullable(),
});
export type OfflineCounterView = z.infer<typeof offlineCounterSchema>;

export const actionErrorSchema = z.object({ code: z.string(), message: z.string() });
export type ActionError = z.infer<typeof actionErrorSchema>;

/** Actions report refusals as data so the person at the counter sees why, not a generic error. */
function result<T extends z.ZodTypeAny>(value: T) {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), value }),
    z.object({ ok: z.literal(false), error: actionErrorSchema }),
  ]);
}
export type ActionResult<T> = { ok: true; value: T } | { ok: false; error: ActionError };

const credentials = z.object({ email: z.string().trim().min(3).max(254), password: z.string().min(1).max(256) });
const label = z.string().trim().min(1).max(120);
const pin = z.string().regex(/^\d{4,8}$/);

const noInput = z.undefined();

export const ipcContract = {
  getAppInfo: { channel: "pos:app:info", input: noInput, output: appInfoSchema },
  getReadiness: { channel: "pos:readiness:get", input: noInput, output: readinessReportSchema },
  checkApi: { channel: "pos:api:check", input: noInput, output: apiReachabilitySchema },
  listPrinters: { channel: "pos:printers:list", input: noInput, output: z.array(printerSchema) },
  printTestReceipt: {
    channel: "pos:printers:test-receipt",
    input: z.object({ printerName: z.string().min(1).max(260) }),
    output: printResultSchema,
  },
  getDeviceState: { channel: "pos:device:state", input: noInput, output: deviceStateSchema },
  setServerUrl: {
    channel: "pos:device:server-url",
    input: z.object({ url: z.string().trim().min(1).max(2048) }),
    output: result(deviceStateSchema),
  },
  signIn: { channel: "pos:auth:sign-in", input: credentials, output: result(deviceStateSchema) },
  signOut: { channel: "pos:auth:sign-out", input: noInput, output: result(deviceStateSchema) },
  refreshEnrollment: { channel: "pos:device:refresh", input: noInput, output: result(deviceStateSchema) },
  listCounters: {
    channel: "pos:enrollment:counters",
    input: z.object({ branchId: uuid }),
    output: result(z.array(counterSchema)),
  },
  createCounter: {
    channel: "pos:enrollment:create-counter",
    input: z.object({ branchId: uuid, label }),
    output: result(counterSchema),
  },
  enrollWithCode: {
    channel: "pos:enrollment:enroll-with-code",
    input: z.object({ branchId: uuid, code: z.string().trim().min(4).max(32), label }),
    output: result(deviceStateSchema),
  },
  offlineCounter: { channel: "pos:offline:status", input: noInput, output: result(offlineCounterSchema) },
  activateOffline: {
    channel: "pos:offline:activate",
    input: z.object({ authorizationId: uuid }),
    output: result(offlineCounterSchema),
  },
  setPin: {
    channel: "pos:staff:set-pin",
    input: z.object({ pin, password: z.string().min(1).max(256) }),
    output: result(deviceStateSchema),
  },
  preparePin: { channel: "pos:staff:prepare-pin", input: z.object({ pin }), output: result(deviceStateSchema) },
  lock: { channel: "pos:staff:lock", input: noInput, output: result(deviceStateSchema) },
  unlock: { channel: "pos:staff:unlock", input: z.object({ pin }), output: result(deviceStateSchema) },
  enroll: {
    channel: "pos:enrollment:enroll",
    input: z.object({ branchId: uuid, registerId: uuid, label }),
    output: result(deviceStateSchema),
  },
} as const;

export type IpcContract = typeof ipcContract;
export type IpcMethod = keyof IpcContract;
export type IpcInput<M extends IpcMethod> = z.infer<IpcContract[M]["input"]>;
export type IpcOutput<M extends IpcMethod> = z.infer<IpcContract[M]["output"]>;

/** What the preload script exposes as `window.pos`. */
export type PosBridge = {
  [M in IpcMethod]: undefined extends IpcInput<M>
    ? () => Promise<IpcOutput<M>>
    : (input: IpcInput<M>) => Promise<IpcOutput<M>>;
};
