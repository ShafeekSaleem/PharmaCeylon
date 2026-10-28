import { act, renderHook, waitFor } from "@testing-library/react";
import { apiJson } from "./auth-client";
import { resetPermissionsCache, usePermissions } from "./permissions";

let mockBranchId = "branch-a";
let mockUser = { id: "user-a" };
jest.mock("./use-auth", () => ({
  useAuth: () => ({ user: mockUser, ready: true, branchId: mockBranchId }),
}));
jest.mock("./auth-client", () => ({ apiJson: jest.fn() }));
const request = jest.mocked(apiJson);

beforeEach(() => {
  resetPermissionsCache();
  request.mockReset();
  mockBranchId = "branch-a";
  mockUser = { id: "user-a" };
});

it("does not carry an allowed web scope across a branch or user switch", async () => {
  request.mockResolvedValueOnce({ permissionKeys: ["inventory.view"], backOfficeAccess: true });
  const { result, rerender } = renderHook(() => usePermissions());
  await waitFor(() => expect(result.current.backOfficeAccess).toBe(true));
  let finish: (value: unknown) => void = () => {};
  request.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }) as never);
  mockBranchId = "branch-b";
  rerender();
  expect(result.current.backOfficeAccess).toBe(false);
  expect(result.current.accessResolved).toBe(false);
  await act(async () => finish({ permissionKeys: ["sales.pos_use"], backOfficeAccess: false }));
  expect(result.current.permissionKeys).toEqual(["sales.pos_use"]);
  expect(result.current.backOfficeAccess).toBe(false);
  request.mockResolvedValueOnce({ permissionKeys: ["sales.view"], backOfficeAccess: true });
  mockUser = { id: "user-b" };
  rerender();
  expect(result.current.backOfficeAccess).toBe(false);
  await waitFor(() => expect(result.current.backOfficeAccess).toBe(true));
  expect(request).toHaveBeenCalledTimes(3);
});

it("clears an allowed scope when revalidation fails and does not reuse it after remount", async () => {
  request.mockResolvedValueOnce({ permissionKeys: ["inventory.view"], backOfficeAccess: true });
  const first = renderHook(() => usePermissions());
  await waitFor(() => expect(first.result.current.backOfficeAccess).toBe(true));
  request.mockRejectedValue(new Error("unavailable"));
  await act(async () => window.dispatchEvent(new Event("focus")));
  await waitFor(() => expect(first.result.current.accessResolved).toBe(false));
  expect(first.result.current.backOfficeAccess).toBe(false);
  first.unmount();
  const next = renderHook(() => usePermissions());
  expect(next.result.current.backOfficeAccess).toBe(false);
  await waitFor(() => expect(next.result.current.loading).toBe(false));
  expect(next.result.current.accessResolved).toBe(false);
});
