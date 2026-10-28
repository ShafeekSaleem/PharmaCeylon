import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { classifyMutation, classifyProfile } from "./operation-classification";
import { MUTATION_ACTIONS } from "./mutation-actions";
import { INTERNAL_OPERATION_ACTIONS } from "./internal-operation-actions";

const route = (path: string, method = "POST") => classifyMutation(method, `/api/v1/${path}`);

describe("P1 server action classification", () => {
  it("explicitly covers every inventoried route with no extra or duplicate declaration", () => {
    const inventory = JSON.parse(readFileSync(resolve(__dirname, "../../../../docs/POS_MUTATION_ROUTES.json"), "utf8")) as { method: string; path: string }[];
    const keys = inventory.map(r => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(Object.keys(MUTATION_ACTIONS).sort()).toEqual(keys.sort());
    for (const profile of Object.values(MUTATION_ACTIONS)) {
      expect(classifyProfile(profile, { paymentKind: "bank", clinicalSale: false, cashMovement: false, readinessTask: "sales_settings" }).effects.length).toBeGreaterThan(0);
    }
    for (const entry of INTERNAL_OPERATION_ACTIONS) expect(existsSync(resolve(__dirname, "..", entry.source))).toBe(true);
  });

  it("fails closed for new routes, actual URLs, wrong methods and prototype keys", () => {
    for (const path of ["/api/v1/new-action", "/api/v1/sales/123/refund", "toString"]) {
      expect(() => classifyMutation("POST", path)).toThrow("Unclassified mutation");
    }
    expect(() => classifyMutation("GET", "/api/v1/sales/checkout")).toThrow();
    expect(() => classifyProfile("unknown" as never)).toThrow();
  });

  it.each(["products/import/confirm"])("does not mistake mixed handler %s for remote approval", path => {
    expect(route(path)).toMatchObject({ requiresLocalTerminal: true, needsApprovalExecutionSplit: true });
    expect(route(path).effects).toContain("physical_stock");
  });

  it("separates management import drafts from physical posting and legacy stock undo", () => {
    for (const path of ["products/import/stage", "products/import/:importId/stock/replace", "products/import/:importId/undo"]) expect(route(path).requiresLocalTerminal).toBe(false);
    for (const path of ["products/import/:importId/stock/post", "products/import/:importId/undo-stock"]) expect(route(path)).toMatchObject({ requiresLocalTerminal: true, needsApprovalExecutionSplit: false });
  });

  it.each(["purchasing/purchase-orders/:id/approve", "returns/:id/approve", "inventory/held-adjustments/:id/reject", "stocktakes/:id/request-recount", "stocktakes/:id/approve", "inventory/held-adjustments/:id/accept", "purchasing/held-deliveries/:id/accept", "products"])("permits remote management classification for %s", path => {
    expect(route(path).requiresLocalTerminal).toBe(false);
  });

  it("keeps stocktake posting physical after approval is separated", () => {
    expect(route("stocktakes/:id/post")).toMatchObject({ effects: ["physical_stock"], requiresLocalTerminal: true, needsApprovalExecutionSplit: false });
  });

  it("keeps normal reservations remote but both transfer execution ends local", () => {
    for (const path of ["transfers", "transfers/:id/approve", "transfers/:id/cancel"]) {
      expect(route(path).effects).toContain("business_reservation");
      expect(route(path).requiresLocalTerminal).toBe(false);
    }
    for (const path of ["transfers/:id/ship", "transfers/:id/receive"]) expect(route(path).requiresLocalTerminal).toBe(true);
  });

  it("requires resolved payment kind on both modern and legacy payment paths", () => {
    for (const path of ["purchasing/payments", "purchasing/payments/:id/void", "suppliers/invoices/:id/payments"]) {
      expect(() => route(path)).toThrow("payment kind");
      expect(classifyMutation("POST", `/api/v1/${path}`, { paymentKind: "bank" })).toMatchObject({ effects: ["bank_payment_record"], requiresLocalTerminal: false });
      expect(classifyMutation("POST", `/api/v1/${path}`, { paymentKind: "cash" }).requiresLocalTerminal).toBe(true);
    }
    expect(() => classifyProfile("supplier_payment", { paymentKind: "other" as never })).toThrow();
  });

  it("requires product-derived clinical facts without requiring a pharmacist for ordinary sales", () => {
    expect(() => route("sales/checkout")).toThrow("clinical");
    expect(classifyProfile("checkout", { clinicalSale: false, cashMovement: false }).effects).not.toContain("clinical_dispensing");
    expect(classifyProfile("checkout", { clinicalSale: true, cashMovement: false }).effects).toContain("clinical_dispensing");
    expect(route("prescriptions").requiresLocalTerminal).toBe(true);
  });

  it("includes cash effects for cash or split tender and cash refunds", () => {
    expect(classifyProfile("checkout", { clinicalSale: false, cashMovement: true }).effects).toContain("branch_cash");
    expect(classifyProfile("refund", { cashMovement: true }).effects).toContain("branch_cash");
    expect(classifyProfile("refund", { cashMovement: false }).effects).not.toContain("branch_cash");
    expect(() => classifyProfile("checkout", { clinicalSale: false })).toThrow("cash movement");
    expect(() => classifyProfile("refund")).toThrow("cash movement");
  });

  it("keeps local confirmations local even without a ledger movement", () => {
    for (const path of ["stocktakes/:id/complete", "sales/holds", "returns/:id/mark-logistics", "purchasing/purchase-orders/:id/hold-delivery"]) expect(route(path).requiresLocalTerminal).toBe(true);
    expect(classifyProfile("readiness_confirmation", { readinessTask: "sales_settings" }).requiresLocalTerminal).toBe(false);
    expect(classifyProfile("readiness_confirmation", { readinessTask: "opening_inventory" }).requiresLocalTerminal).toBe(true);
    expect(() => route("setup/readiness/confirm")).toThrow();
  });
});
