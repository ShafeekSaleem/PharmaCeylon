export const APP_NAME = "PharmaCeylon";

export type HealthStatus = {
  ok: boolean;
  service: string;
  timestamp: string;
};
export * from "./dashboard";
export * from "./terminal-contracts";
export * from "./operation-policy";
export * from "./pos-resilience-contracts";
export * from "./terminal-online-protocol";
export * from "./branch-hours";
export * from "./counter-policy";
export * from "./counter-grant-settings";
