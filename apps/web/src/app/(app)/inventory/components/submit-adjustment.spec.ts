import { ApiError } from "@/lib/api-error";
import { apiJson } from "@/lib/auth-client";
import { submitAdjustment, writeOffRequestKeys } from "./submit-adjustment";

jest.mock("@/lib/auth-client", () => ({ apiJson: jest.fn() }));
const body = {
  kind: "lost",
  productId: "product",
  batchId: "batch",
  qty: 2,
  reason: "Missing",
};
const KEY = "write-off-key-1";
const refusal = (code: string) =>
  new ApiError("Refused", 409, { code, message: "Refused", statusCode: 409 });

beforeEach(() => jest.mocked(apiJson).mockReset());

it("posts directly when the server allows it, with no key", async () => {
  jest.mocked(apiJson).mockResolvedValueOnce({ held: false });
  await expect(submitAdjustment(body, KEY)).resolves.toEqual({ held: false });
  expect(apiJson).toHaveBeenCalledTimes(1);
  expect(apiJson).toHaveBeenCalledWith("/inventory/adjustments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
});

it("sends the same write-off for approval under its key only when posting needs approval", async () => {
  jest
    .mocked(apiJson)
    .mockRejectedValueOnce(refusal("WRITE_OFF_APPROVAL_REQUIRED"))
    .mockResolvedValueOnce({ held: true });
  await expect(submitAdjustment(body, KEY)).resolves.toEqual({ held: true });
  expect(apiJson).toHaveBeenLastCalledWith("/inventory/adjustment-requests", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": KEY },
    body: JSON.stringify(body),
  });
});

it("does not turn any other refusal into a request", async () => {
  jest.mocked(apiJson).mockRejectedValueOnce(refusal("PERMISSION_DENIED"));
  await expect(submitAdjustment(body, KEY)).rejects.toThrow("Refused");
  expect(apiJson).toHaveBeenCalledTimes(1);
});

it("keeps one key while the entry is unchanged and starts a new one when it changes", () => {
  let n = 0;
  const keyFor = writeOffRequestKeys(() => `k${++n}`);
  const first = keyFor(body);
  expect(keyFor({ ...body })).toBe(first);
  const changed = keyFor({ ...body, qty: 3 });
  expect(changed).not.toBe(first);
  // Going back to the first entry is a new request too: the key is for the latest entry only.
  expect(keyFor(body)).not.toBe(first);
  expect(first).toMatch(/^write-off-k1$/);
  expect(first.length).toBeLessThanOrEqual(128);
});

it("makes UUID-based keys by default", () => {
  expect(writeOffRequestKeys()(body)).toMatch(
    /^write-off-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});
