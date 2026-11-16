import { act, renderHook, waitFor } from "@testing-library/react";
import { apiJson } from "@/lib/auth-client";
import { ApiError } from "@/lib/api-error";
import { useCashPayouts } from "./use-cash-payouts";

jest.mock("@/lib/auth-client", () => ({ apiJson: jest.fn() }));
jest.mock("@/lib/use-auth", () => ({
  useAuth: () => ({ branchId: "branch-a", user: { id: "user-a", tenantId: "tenant-a" } }),
}));

beforeEach(() => {
  jest.mocked(apiJson).mockReset();
});

describe("useCashPayouts", () => {
  it("marks permission denied on 403 without parsing the message", async () => {
    jest
      .mocked(apiJson)
      .mockRejectedValueOnce(new ApiError("Forbidden", 403, { statusCode: 403 }));
    const view = renderHook(() => useCashPayouts());
    await waitFor(() => expect(view.result.current.permissionDenied).toBe(true));
    expect(view.result.current.rows).toEqual([]);
  });

  it("reloads when called after the first fetch", async () => {
    jest.mocked(apiJson).mockResolvedValueOnce([{ id: "one" }]).mockResolvedValueOnce([{ id: "two" }]);
    const view = renderHook(() => useCashPayouts());
    await waitFor(() => expect(view.result.current.rows).toEqual([{ id: "one" }]));
    await act(async () => {
      await view.result.current.reload();
    });
    expect(view.result.current.rows).toEqual([{ id: "two" }]);
  });
});