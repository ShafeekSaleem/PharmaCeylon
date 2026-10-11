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
