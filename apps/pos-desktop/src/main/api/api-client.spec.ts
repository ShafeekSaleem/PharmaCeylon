import { ApiError, ApiSession, type FetchLike } from "./api-client";

const user = {
  id: "u1",
  tenantId: "t1",
  email: "a@b.c",
  fullName: "A",
  roles: [],
  branchRoles: [],
};
const reply = (status: number, body?: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => (body === undefined ? "" : JSON.stringify(body)),
});

describe("ApiSession", () => {
  it("sends Bearer auth and the branch header, never cookies", async () => {
    const fetchImpl = jest
      .fn<ReturnType<FetchLike>, Parameters<FetchLike>>()
      .mockResolvedValueOnce(
        reply(200, { accessToken: "a1", refreshToken: "r1", user }),
      )
      .mockResolvedValueOnce(reply(200, []));
    const api = new ApiSession(() => "https://pos.test/api/v1/", fetchImpl);
    await api.login("a@b.c", "secret");
    await api.request("GET", "/terminals/counters", { branchId: "b1" });
    const [url, init] = fetchImpl.mock.calls[1]!;
    expect(url).toBe("https://pos.test/api/v1/terminals/counters");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer a1",
      "x-branch-id": "b1",
    });
    expect(init.headers.Cookie).toBeUndefined();
  });

  it("refreshes once on 401 and retries", async () => {
    const fetchImpl = jest
      .fn<ReturnType<FetchLike>, Parameters<FetchLike>>()
      .mockResolvedValueOnce(
        reply(200, { accessToken: "a1", refreshToken: "r1", user }),
      )
      .mockResolvedValueOnce(reply(401, { message: "expired" }))
      .mockResolvedValueOnce(
        reply(200, { accessToken: "a2", refreshToken: "r2", user }),
      )
      .mockResolvedValueOnce(reply(200, { ok: true }));
    const api = new ApiSession(() => "https://pos.test/api/v1", fetchImpl);
    await api.login("a@b.c", "secret");
    await expect(api.request("GET", "/x")).resolves.toEqual({ ok: true });
    expect(fetchImpl.mock.calls[3]![1].headers.Authorization).toBe("Bearer a2");
  });

  it("keeps the server's refusal and marks transport failures uncertain", async () => {
    const fetchImpl = jest
      .fn<ReturnType<FetchLike>, Parameters<FetchLike>>()
      .mockResolvedValueOnce(
        reply(200, { accessToken: "a1", refreshToken: "r1", user }),
      )
      .mockResolvedValueOnce(
        reply(403, { code: "PIN_LOCKED", message: "no", lockedUntil: "2026-11-03T10:15:00.000Z" }),
      )
      .mockRejectedValueOnce(new Error("socket hang up"));
    const api = new ApiSession(() => "https://pos.test/api/v1", fetchImpl);
    await api.login("a@b.c", "secret");
    const refused = await api.request("POST", "/x").catch((e: ApiError) => e);
    expect(refused).toMatchObject({
      status: 403,
      code: "PIN_LOCKED",
      uncertain: false,
      // Detail beyond the code stays readable.
      body: { lockedUntil: "2026-11-03T10:15:00.000Z" },
    });
    const lost = await api.request("POST", "/x").catch((e: ApiError) => e);
    expect(lost).toMatchObject({ code: "NETWORK", uncertain: true });
  });

  it("refreshes once when two requests fail together, so the server never sees token reuse", async () => {
    let refreshes = 0;
    const fetchImpl = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>(
      async (url, init) => {
        if (url.endsWith("/auth/login"))
          return reply(200, { accessToken: "a1", refreshToken: "r1", user });
        if (url.endsWith("/auth/refresh")) {
          refreshes += 1;
          // The second use of r1 would revoke the whole login on the real server.
          if (JSON.parse(init.body!).refreshToken !== "r1")
            return reply(401, { message: "reuse" });
          await new Promise((resolve) => setTimeout(resolve, 5));
          return reply(200, { accessToken: "a2", refreshToken: "r2", user });
        }
        return init.headers.Authorization === "Bearer a2"
          ? reply(200, { url })
          : reply(401, { message: "expired" });
      },
    );
    const api = new ApiSession(() => "https://pos.test/api/v1", fetchImpl);
    await api.login("a@b.c", "secret");
    await expect(
      Promise.all([api.request("GET", "/catalog"), api.request("GET", "/refunds")]),
    ).resolves.toHaveLength(2);
    expect(refreshes).toBe(1);
    // A request that started with the old token after the refresh just retries.
    await expect(api.request("GET", "/later")).resolves.toBeTruthy();
    expect(refreshes).toBe(1);
  });

  it("never refreshes and resends a 401 that carries a refusal code, so a wrong secret counts once", async () => {
    const fetchImpl = jest
      .fn<ReturnType<FetchLike>, Parameters<FetchLike>>()
      .mockResolvedValueOnce(
        reply(200, { accessToken: "a1", refreshToken: "r1", user }),
      )
      .mockResolvedValueOnce(
        reply(401, { code: "PIN_INCORRECT", message: "That PIN is not right." }),
      );
    const api = new ApiSession(() => "https://pos.test/api/v1", fetchImpl);
    await api.login("a@b.c", "secret");
    await expect(api.request("POST", "/terminals/sessions/s/prepare")).rejects.toMatchObject({
      status: 401,
      code: "PIN_INCORRECT",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(api.user).toEqual(user);
  });

  it("keeps the tokens when the refresh can't reach the server", async () => {
    const fetchImpl = jest
      .fn<ReturnType<FetchLike>, Parameters<FetchLike>>()
      .mockResolvedValueOnce(
        reply(200, { accessToken: "a1", refreshToken: "r1", user }),
      )
      .mockResolvedValueOnce(reply(401, { message: "expired" }))
      .mockRejectedValueOnce(new Error("offline"));
    const api = new ApiSession(() => "https://pos.test/api/v1", fetchImpl);
    await api.login("a@b.c", "secret");
    await expect(api.request("GET", "/x")).rejects.toMatchObject({
      code: "NETWORK",
      uncertain: true,
    });
    expect(api.user).toEqual(user);
  });

  it("drops the tokens when the server refuses the refresh", async () => {
    const fetchImpl = jest
      .fn<ReturnType<FetchLike>, Parameters<FetchLike>>()
      .mockResolvedValueOnce(
        reply(200, { accessToken: "a1", refreshToken: "r1", user }),
      )
      .mockResolvedValueOnce(reply(401, { message: "expired" }))
      .mockResolvedValueOnce(reply(401, { message: "revoked" }));
    const api = new ApiSession(() => "https://pos.test/api/v1", fetchImpl);
    await api.login("a@b.c", "secret");
    await expect(api.request("GET", "/x")).rejects.toMatchObject({ status: 401 });
    expect(api.user).toBeNull();
  });

  it("drops tokens on logout even when the server is unreachable", async () => {
    const fetchImpl = jest
      .fn<ReturnType<FetchLike>, Parameters<FetchLike>>()
      .mockResolvedValueOnce(
        reply(200, { accessToken: "a1", refreshToken: "r1", user }),
      )
      .mockRejectedValueOnce(new Error("offline"));
    const api = new ApiSession(() => "https://pos.test/api/v1", fetchImpl);
    await api.login("a@b.c", "secret");
    await api.logout();
    expect(api.user).toBeNull();
  });
});
