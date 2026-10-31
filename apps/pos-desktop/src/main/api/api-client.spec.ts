import { ApiError, ApiSession, type FetchLike } from "./api-client";

const user = { id: "u1", tenantId: "t1", email: "a@b.c", fullName: "A", roles: [], branchRoles: [] };
const reply = (status: number, body?: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => (body === undefined ? "" : JSON.stringify(body)),
});

describe("ApiSession", () => {
  it("sends Bearer auth and the branch header, never cookies", async () => {
    const fetchImpl = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>()
      .mockResolvedValueOnce(reply(200, { accessToken: "a1", refreshToken: "r1", user }))
      .mockResolvedValueOnce(reply(200, []));
    const api = new ApiSession(() => "https://pos.test/api/v1/", fetchImpl);
    await api.login("a@b.c", "secret");
    await api.request("GET", "/terminals/counters", { branchId: "b1" });
    const [url, init] = fetchImpl.mock.calls[1]!;
    expect(url).toBe("https://pos.test/api/v1/terminals/counters");
    expect(init.headers).toMatchObject({ Authorization: "Bearer a1", "x-branch-id": "b1" });
    expect(init.headers.Cookie).toBeUndefined();
  });

  it("refreshes once on 401 and retries", async () => {
    const fetchImpl = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>()
      .mockResolvedValueOnce(reply(200, { accessToken: "a1", refreshToken: "r1", user }))
      .mockResolvedValueOnce(reply(401, { message: "expired" }))
      .mockResolvedValueOnce(reply(200, { accessToken: "a2", refreshToken: "r2", user }))
      .mockResolvedValueOnce(reply(200, { ok: true }));
    const api = new ApiSession(() => "https://pos.test/api/v1", fetchImpl);
    await api.login("a@b.c", "secret");
    await expect(api.request("GET", "/x")).resolves.toEqual({ ok: true });
    expect(fetchImpl.mock.calls[3]![1].headers.Authorization).toBe("Bearer a2");
  });

  it("keeps the server's refusal code and marks transport failures uncertain", async () => {
    const fetchImpl = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>()
      .mockResolvedValueOnce(reply(200, { accessToken: "a1", refreshToken: "r1", user }))
      .mockResolvedValueOnce(reply(403, { code: "REMOTE_SESSION_DENIED", message: "no" }))
      .mockRejectedValueOnce(new Error("socket hang up"));
    const api = new ApiSession(() => "https://pos.test/api/v1", fetchImpl);
    await api.login("a@b.c", "secret");
    const refused = await api.request("POST", "/x").catch((e: ApiError) => e);
    expect(refused).toMatchObject({ status: 403, code: "REMOTE_SESSION_DENIED", uncertain: false });
    const lost = await api.request("POST", "/x").catch((e: ApiError) => e);
    expect(lost).toMatchObject({ code: "NETWORK", uncertain: true });
  });

  it("drops tokens on logout even when the server is unreachable", async () => {
    const fetchImpl = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>()
      .mockResolvedValueOnce(reply(200, { accessToken: "a1", refreshToken: "r1", user }))
      .mockRejectedValueOnce(new Error("offline"));
    const api = new ApiSession(() => "https://pos.test/api/v1", fetchImpl);
    await api.login("a@b.c", "secret");
    await api.logout();
    expect(api.user).toBeNull();
  });
});
