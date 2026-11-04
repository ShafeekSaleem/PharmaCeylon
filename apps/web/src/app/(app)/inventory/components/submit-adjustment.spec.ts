import { ApiError } from "@/lib/api-error";
import { apiJson } from "@/lib/auth-client";
import { adjustmentKeys, submitAdjustment } from "./submit-adjustment";

jest.mock("@/lib/auth-client", () => ({ apiJson: jest.fn() }));
const body = {
  kind: "lost",
  productId: "product",
  batchId: "batch",
  qty: 2,
  reason: "Missing",
};
const KEYS = { post: "adjustment-key-1", request: "write-off-key-1" };
const refusal = (code: string) =>
  new ApiError("Refused", 409, { code, message: "Refused", statusCode: 409 });
const sent = (path: string, key: string) =>
  [
    path,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify(body),
    },
  ] as const;

beforeEach(() => jest.mocked(apiJson).mockReset());

it("posts directly under the post key when the server allows it", async () => {
  jest.mocked(apiJson).mockResolvedValueOnce({ held: false });
  await expect(submitAdjustment(body, KEYS)).resolves.toEqual({ held: false });
  expect(jest.mocked(apiJson).mock.calls).toEqual([sent("/inventory/adjustments", KEYS.post)]);
});

it("sends the same write-off for approval under the request key only when posting needs approval", async () => {
  jest
    .mocked(apiJson)
    .mockRejectedValueOnce(refusal("WRITE_OFF_APPROVAL_REQUIRED"))
    .mockResolvedValueOnce({ held: true });
  await expect(submitAdjustment(body, KEYS)).resolves.toEqual({ held: true });
  expect(jest.mocked(apiJson).mock.calls).toEqual([
    sent("/inventory/adjustments", KEYS.post),
    sent("/inventory/adjustment-requests", KEYS.request),
  ]);
});

it("saves a refused write-off again under the same two keys, so its request is held once", async () => {
  jest
    .mocked(apiJson)
    .mockRejectedValueOnce(refusal("WRITE_OFF_APPROVAL_REQUIRED"))
    .mockRejectedValueOnce(new TypeError("Failed to fetch")) // the request's reply is lost
    .mockRejectedValueOnce(refusal("WRITE_OFF_APPROVAL_REQUIRED"))
    .mockResolvedValueOnce({ held: true });
  const keysFor = adjustmentKeys();
  await expect(submitAdjustment(body, keysFor(body))).rejects.toThrow("Failed to fetch");
  await expect(submitAdjustment({ ...body }, keysFor({ ...body }))).resolves.toEqual({ held: true });
  const calls = jest.mocked(apiJson).mock.calls;
  const keyOf = (index: number) =>
    (calls[index]![1]!.headers as Record<string, string>)["Idempotency-Key"];
  expect(calls.map(([path]) => path)).toEqual([
    "/inventory/adjustments",
    "/inventory/adjustment-requests",
    "/inventory/adjustments",
    "/inventory/adjustment-requests",
  ]);
  expect(keyOf(2)).toBe(keyOf(0));
  expect(keyOf(3)).toBe(keyOf(1));
  expect(keyOf(0)).not.toBe(keyOf(1));
});

it("does not turn any other refusal into a request", async () => {
  jest.mocked(apiJson).mockRejectedValueOnce(refusal("PERMISSION_DENIED"));
  await expect(submitAdjustment(body, KEYS)).rejects.toThrow("Refused");
  expect(apiJson).toHaveBeenCalledTimes(1);
});

it("keeps one pair of keys while the entry is unchanged and starts new ones when it changes", () => {
  let n = 0;
  const keysFor = adjustmentKeys(() => `k${++n}`);
  const first = keysFor(body);
  expect(first).toEqual({ post: "adjustment-k1", request: "write-off-k2" });
  expect(keysFor({ ...body })).toBe(first);
  const changed = keysFor({ ...body, qty: 3 });
  expect(changed.post).not.toBe(first.post);
  expect(changed.request).not.toBe(first.request);
  // Going back to the first entry is a new adjustment too: the keys are for the latest entry only.
  expect(keysFor(body).post).not.toBe(first.post);
});

it("makes distinct UUID-based keys within the API's 128-character limit by default", () => {
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
  const keys = adjustmentKeys()(body);
  expect(keys.post).toMatch(new RegExp(`^adjustment-${uuid}$`));
  expect(keys.request).toMatch(new RegExp(`^write-off-${uuid}$`));
  expect(keys.post.slice("adjustment-".length)).not.toBe(keys.request.slice("write-off-".length));
  expect(Math.max(keys.post.length, keys.request.length)).toBeLessThanOrEqual(128);
});
