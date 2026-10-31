/** Minimal fetch surface; production passes Electron's net.fetch with credentials omitted. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal },
) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>;

export type AuthUser = {
  id: string;
  tenantId: string;
  email: string;
  fullName: string;
  roles: string[];
  branchRoles: { branchId: string; role: string }[];
};

type Tokens = { accessToken: string; refreshToken: string; user: AuthUser };

/** Server refusals keep their code so callers can explain them; transport failures are `network`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** The request may or may not have reached the server, so its effect is unknown. */
  get uncertain(): boolean {
    return this.status === 0 || this.status >= 500;
  }
}

const TIMEOUT_MS = 15_000;

function parseError(status: number, text: string): ApiError {
  let code = `HTTP_${status}`;
  let message = "The server refused the request.";
  try {
    const body = JSON.parse(text) as { code?: unknown; message?: unknown };
    if (typeof body.code === "string") code = body.code;
    if (typeof body.message === "string") message = body.message;
    else if (Array.isArray(body.message) && typeof body.message[0] === "string") message = body.message[0];
  } catch {
    // Not JSON: keep the generic message.
  }
  return new ApiError(status, code, message);
}

/**
 * One signed-in user's API session, held in main-process memory only: tokens are never written
 * to disk, never sent to the renderer and vanish when the app quits. Bearer auth, so the server's
 * cookie/CSRF flow never applies; the fetch implementation must not use a cookie jar.
 */
export class ApiSession {
  private tokens: Tokens | null = null;

  constructor(
    private readonly baseUrl: () => string | null,
    private readonly fetchImpl: FetchLike,
  ) {}

  get user(): AuthUser | null {
    return this.tokens?.user ?? null;
  }

  async login(email: string, password: string): Promise<AuthUser> {
    const result = await this.send<{ accessToken: string; refreshToken: string; user: AuthUser }>("POST", "/auth/login", {
      body: { email, password },
      auth: false,
    });
    this.tokens = { accessToken: result.accessToken, refreshToken: result.refreshToken, user: result.user };
    return result.user;
  }

  /** Revokes this refresh session; local tokens are dropped whatever the server says. */
  async logout(): Promise<void> {
    const tokens = this.tokens;
    if (!tokens) return;
    try {
      await this.send("POST", "/auth/logout", { body: { refreshToken: tokens.refreshToken } });
    } catch {
      // Offline or already expired: the refresh session simply ages out.
    } finally {
      this.tokens = null;
    }
  }

  forget(): void {
    this.tokens = null;
  }

  request<T>(method: string, path: string, opts: { body?: unknown; branchId?: string } = {}): Promise<T> {
    return this.send<T>(method, path, opts);
  }

  private async send<T>(
    method: string,
    path: string,
    opts: { body?: unknown; branchId?: string; auth?: boolean },
    retried = false,
  ): Promise<T> {
    const base = this.baseUrl();
    if (!base) throw new ApiError(0, "SERVER_NOT_SET", "The server address has not been set.");
    const headers: Record<string, string> = { Accept: "application/json" };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.branchId) headers["x-branch-id"] = opts.branchId;
    if (opts.auth !== false) {
      if (!this.tokens) throw new ApiError(401, "NOT_SIGNED_IN", "Sign in first.");
      headers.Authorization = `Bearer ${this.tokens.accessToken}`;
    }

    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.fetchImpl(`${base.replace(/\/+$/, "")}${path}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new ApiError(0, "NETWORK", "The server could not be reached.");
    }

    if (response.status === 401 && opts.auth !== false && !retried && (await this.refresh())) {
      return this.send<T>(method, path, opts, true);
    }
    const text = await response.text();
    if (!response.ok) throw parseError(response.status, text);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private async refresh(): Promise<boolean> {
    const tokens = this.tokens;
    if (!tokens) return false;
    try {
      const result = await this.send<{ accessToken: string; refreshToken: string; user: AuthUser }>(
        "POST",
        "/auth/refresh",
        { body: { refreshToken: tokens.refreshToken }, auth: false },
      );
      this.tokens = { accessToken: result.accessToken, refreshToken: result.refreshToken, user: result.user };
      return true;
    } catch {
      this.tokens = null;
      return false;
    }
  }
}
