export type BranchRole = {
  branchId: string;
  role: string;
};

export type AuthUser = {
  id: string;
  tenantId: string;
  tenantCode?: string;
  email: string;
  fullName: string;
  roles: string[];
  branchRoles: BranchRole[];
};

/**
 * Shape returned by /auth/login and /auth/refresh.
 *
 * In browser flows we only consume `user`; tokens are set as httpOnly cookies
 * by the server. The token fields are kept here for non-browser clients
 * (mobile, scripts) sharing this type.
 */
export type AuthResponse = {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
  csrfToken: string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
};
