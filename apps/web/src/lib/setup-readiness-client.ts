import { apiJson } from "./auth-client";

export type ReadinessTaskKey =
  | "business_branch"
  | "products"
  | "opening_inventory"
  | "sales_settings"
  | "checkout";

export type SetupReadiness = {
  journeyEnabled: boolean;
  readyForSales: boolean;
  completedCount: number;
  totalCount: number;
  percent: number;
  tenant: { id: string; name: string; hasLogo: boolean };
  branch: { id: string; name: string; code: string; setupMode: string };
  tasks: Array<{
    key: ReadinessTaskKey;
    title: string;
    description: string;
    complete: boolean;
    available: boolean;
    href: string;
    /** The values behind a confirm-style step, so the decision is made against something. */
    facts?: Array<{ label: string; value: string; ok?: boolean }>;
  }>;
  optional: { teamInvited: boolean; logoAdded: boolean };
  nextTask: ReadinessTaskKey | null;
};

export const fetchSetupReadiness = () =>
  apiJson<SetupReadiness>("/setup/readiness");

export const confirmSetupTask = (task: "sales_settings" | "opening_inventory" | "checkout") =>
  apiJson<SetupReadiness>("/setup/readiness/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task }),
  });
