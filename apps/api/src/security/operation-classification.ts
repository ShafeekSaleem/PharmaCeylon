import type { OnlineOperationEffect } from "@pharmaceylon/shared";
import { MUTATION_ACTIONS } from "./mutation-actions";

/** Server-owned policy metadata. This MR does not install enforcement in guards.
 * Call with the Nest route template, never an arbitrary URL or a client action label.
 * Domain services must resolve conditional facts from validated payment/product state.
 */
export type ActionProfile =
  | "management" | "identity" | "personalization" | "attachment"
  | "reservation" | "stock" | "mixed_stock" | "local_record"
  | "checkout" | "refund" | "clinical" | "supplier_payment" | "readiness_confirmation";

export type ResolvedActionFacts = Readonly<{
  paymentKind?: "bank" | "cash";
  clinicalSale?: boolean;
  cashMovement?: boolean;
  readinessTask?: "opening_inventory" | "sales_settings" | "checkout";
}>;

export type ActionClassification = Readonly<{
  effects: readonly OnlineOperationEffect[];
  requiresLocalTerminal: boolean;
  needsApprovalExecutionSplit: boolean;
}>;

/** Missing/unknown conditional facts are errors, never a remote-management fallback. */
export function classifyProfile(profile: ActionProfile, facts: ResolvedActionFacts = {}): ActionClassification {
  let effects: OnlineOperationEffect[];
  switch (profile) {
    case "management": case "identity": case "personalization": case "attachment": case "local_record":
      effects = ["management_record"]; break;
    case "reservation": effects = ["management_record", "business_reservation"]; break;
    case "stock": effects = ["physical_stock"]; break;
    case "mixed_stock": effects = ["management_record", "physical_stock"]; break;
    case "clinical": effects = ["clinical_dispensing"]; break;
    case "refund":
      if (typeof facts.cashMovement !== "boolean") throw new Error("Resolved cash movement is required");
      effects = ["physical_stock", "customer_refund_execution"];
      if (facts.cashMovement) effects.push("branch_cash");
      break;
    case "checkout":
      if (typeof facts.clinicalSale !== "boolean") throw new Error("Resolved clinical sale classification is required");
      if (typeof facts.cashMovement !== "boolean") throw new Error("Resolved cash movement is required");
      effects = ["physical_stock"];
      if (facts.clinicalSale) effects.push("clinical_dispensing");
      if (facts.cashMovement) effects.push("branch_cash");
      break;
    case "supplier_payment":
      if (facts.paymentKind !== "bank" && facts.paymentKind !== "cash") throw new Error("Resolved payment kind is required");
      effects = [facts.paymentKind === "bank" ? "bank_payment_record" : "branch_cash"]; break;
    case "readiness_confirmation":
      if (!["opening_inventory", "sales_settings", "checkout"].includes(facts.readinessTask ?? "")) {
        throw new Error("Resolved readiness task is required");
      }
      effects = ["management_record"]; break;
    default: throw new Error(`Unclassified action profile: ${String(profile)}`);
  }
  return Object.freeze({
    effects: Object.freeze(effects),
    requiresLocalTerminal: profile === "local_record" ||
      (profile === "readiness_confirmation" && facts.readinessTask !== "sales_settings") || effects.some(effect =>
      ["physical_stock", "branch_cash", "customer_refund_execution", "clinical_dispensing"].includes(effect)),
    needsApprovalExecutionSplit: profile === "mixed_stock",
  });
}

export function classifyMutation(method: string, routeTemplate: string, facts?: ResolvedActionFacts): ActionClassification {
  const key = `${method} ${routeTemplate}`;
  if (!Object.prototype.hasOwnProperty.call(MUTATION_ACTIONS, key)) throw new Error(`Unclassified mutation: ${key}`);
  return classifyProfile(MUTATION_ACTIONS[key as keyof typeof MUTATION_ACTIONS], facts);
}
