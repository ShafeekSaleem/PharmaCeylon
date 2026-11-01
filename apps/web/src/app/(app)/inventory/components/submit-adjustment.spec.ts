import { ApiError } from "@/lib/api-error";
import { apiJson } from "@/lib/auth-client";
import { submitAdjustment } from "./submit-adjustment";

jest.mock("@/lib/auth-client", () => ({ apiJson: jest.fn() }));
const body = { kind: "lost", productId: "product", batchId: "batch", qty: 2, reason: "Missing" };
const refusal = (code: string) =>
  new ApiError("Refused", 409, { code, message: "Refused", statusCode: 409 });

beforeEach(() => jest.mocked(apiJson).mockReset());

it("posts directly when the server allows it", async () => {
  jest.mocked(apiJson).mockResolvedValueOnce({ held: false });
  await expect(submitAdjustment(body)).resolves.toEqual({ held: false });
  expect(apiJson).toHaveBeenCalledTimes(1);
  expect(apiJson).toHaveBeenCalledWith("/inventory/adjustments", expect.objectContaining({ body: JSON.stringify(body) }));
});

it("sends the same write-off for approval only when posting needs approval", async () => {
  jest.mocked(apiJson).mockRejectedValueOnce(refusal("WRITE_OFF_APPROVAL_REQUIRED")).mockResolvedValueOnce({ held: true });
  await expect(submitAdjustment(body)).resolves.toEqual({ held: true });
  expect(apiJson).toHaveBeenLastCalledWith("/inventory/adjustment-requests",
    expect.objectContaining({ method: "POST", body: JSON.stringify(body) }));
});

it("does not turn any other refusal into a request", async () => {
  jest.mocked(apiJson).mockRejectedValueOnce(refusal("PERMISSION_DENIED"));
  await expect(submitAdjustment(body)).rejects.toThrow("Refused");
  expect(apiJson).toHaveBeenCalledTimes(1);
});
