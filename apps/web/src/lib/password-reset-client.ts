import { getApiBaseUrl } from "./api-base";
import { parseApiError } from "./api-error";

export type PasswordResetTokenDetails = {
  /** Masked by the server — enough to recognise the account, not to harvest it. */
  email: string;
  expiresAt: string;
};

async function resetFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    ...init,
    credentials: "include",
  });
  if (!response.ok) {
    throw new Error(
      parseApiError(await response.text(), `Request failed (${response.status})`),
    );
  }
  return response.json() as Promise<T>;
}

/**
 * Always resolves for a well-formed address, whether or not an account exists —
 * the API deliberately does not distinguish, so the UI must not either.
 */
export function requestPasswordReset(email: string) {
  return resetFetch<{ ok: true }>("/auth/password-reset/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
}

export function inspectPasswordResetToken(token: string) {
  return resetFetch<PasswordResetTokenDetails>(
    `/auth/password-reset/${encodeURIComponent(token)}`,
  );
}

export function confirmPasswordReset(token: string, newPassword: string) {
  return resetFetch<{ ok: true }>("/auth/password-reset/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, newPassword }),
  });
}
