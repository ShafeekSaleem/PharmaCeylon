import { getApiBaseUrl } from "./api-base";
import { parseApiError } from "./api-error";
import type { AuthResponse } from "./auth-types";

export type InvitationDetails = {
  email: string;
  fullName: string;
  pharmacyName: string;
  invitedByName: string;
  expiresAt: string;
  accountExists: boolean;
  assignments: Array<{ branchName: string; roleName: string }>;
};

async function invitationFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    ...init,
    credentials: "include",
  });
  if (!response.ok) {
    throw new Error(parseApiError(await response.text(), `Request failed (${response.status})`));
  }
  return response.json() as Promise<T>;
}

export function getStaffInvitation(token: string) {
  return invitationFetch<InvitationDetails>(`/staff-invitations/${encodeURIComponent(token)}`);
}

export function acceptStaffInvitation(
  token: string,
  input: { password: string; fullName?: string },
) {
  return invitationFetch<AuthResponse>(`/staff-invitations/${encodeURIComponent(token)}/accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}
