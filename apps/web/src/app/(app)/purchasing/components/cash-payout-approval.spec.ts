import { describe, expect, it } from "@jest/globals";

/** Mirrors CashPayoutDetail: one approvalId per approve intent until payout/version changes. */
function nextApprovalId(
  current: string | null,
  payoutId: string,
  key: string,
  changedKey: string,
) {
  let id = current;
  if (key !== changedKey) id = null;
  if (!id) id = `new-${changedKey}`;
  return { id, key: changedKey };
}

describe("cash payout approve intent", () => {
  it("reuses approvalId for the same payout version across retries", () => {
    const key = "payout-a:1";
    const first = nextApprovalId(null, "payout-a", key, key);
    const second = nextApprovalId(first.id, "payout-a", first.key, key);
    expect(second.id).toBe(first.id);
  });

  it("clears approvalId when the payout or version changes", () => {
    const first = nextApprovalId(null, "payout-a", "payout-a:1", "payout-a:1");
    const next = nextApprovalId(first.id, "payout-a", first.key, "payout-a:2");
    expect(next.id).not.toBe(first.id);
  });
});