import { getApiBaseUrl } from "./api-base";
import { parseApiError } from "./api-error";

const base = () => getApiBaseUrl();

export type OwnerRegistrationInput = {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  password: string;
};

export type VerifiedOwnerSession = {
  registrationId: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  status: "verified" | "completed";
  completedTenantId: string | null;
  completedUserId: string | null;
  nextPath: "/onboarding/pharmacy" | "/get-started";
};

async function jsonRequest<T>(path: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${base()}${path}`, {
      ...init,
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
  } catch {
    throw new Error(
      "Cannot reach PharmaCeylon. Check your connection and try again.",
    );
  }

  const text = await response.text();
  if (!response.ok) {
    throw new Error(parseApiError(text, `Request failed (${response.status})`));
  }
  return text ? (JSON.parse(text) as T) : ({} as T);
}

export async function createOwnerRegistration(input: OwnerRegistrationInput) {
  return jsonRequest<{ status: "verification_required"; email: string }>(
    "/auth/owner-registration",
    {
      method: "POST",
      body: JSON.stringify({
        ...input,
        email: input.email.trim().toLowerCase(),
        phone: input.phone?.trim() || undefined,
      }),
    },
  );
}

export async function resendOwnerVerification(email: string) {
  return jsonRequest<{ status: "verification_required"; email: string }>(
    "/auth/owner-registration/resend",
    {
      method: "POST",
      body: JSON.stringify({ email: email.trim().toLowerCase() }),
    },
  );
}

export async function verifyOwnerEmail(
  email: string,
  code: string,
): Promise<VerifiedOwnerSession> {
  return jsonRequest<VerifiedOwnerSession>("/auth/owner-registration/verify", {
    method: "POST",
    body: JSON.stringify({
      email: email.trim().toLowerCase(),
      code: code.trim(),
    }),
  });
}

export async function fetchOwnerRegistrationStatus(): Promise<VerifiedOwnerSession> {
  return jsonRequest<VerifiedOwnerSession>("/auth/owner-registration/status", {
    method: "GET",
  });
}
