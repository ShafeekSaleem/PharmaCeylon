import { getApiBaseUrl } from "./api-base";
import { parseApiError } from "./api-error";

export type OnboardingDraft = {
  currentStep: number;
  businessName?: string;
  legalName?: string;
  country?: string;
  currency?: string;
  timezone?: string;
  businessEmail?: string;
  businessPhoneCountryCode?: string;
  businessPhone?: string;
  businessLogoUrl?: string | null;
  branchName?: string;
  branchCode?: string;
  addressLine1?: string;
  city?: string;
  postalCode?: string;
  province?: string;
  district?: string;
  branchCountry?: string;
  branchTimezone?: string;
  branchPhoneCountryCode?: string;
  branchPhone?: string;
  useBusinessPhone?: boolean;
  migrationMode?: "fresh" | "migrating";
  receiptDisplayName?: string;
  paymentMethods?: string[];
  dateFormat?: string;
};

export type OnboardingDraftResponse = {
  draft: OnboardingDraft;
  nextPath: string;
};

async function request(init?: RequestInit): Promise<OnboardingDraftResponse> {
  const response = await fetch(`${getApiBaseUrl()}/onboarding`, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(parseApiError(text, "Unable to save onboarding"));
  return JSON.parse(text) as OnboardingDraftResponse;
}

export const fetchOnboardingDraft = () => request();
export const saveOnboardingDraft = (draft: OnboardingDraft) =>
  request({ method: "PUT", body: JSON.stringify(draft) });

export async function removeOnboardingLogo(): Promise<void> {
  const response = await fetch(`${getApiBaseUrl()}/onboarding/logo`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(parseApiError(text, "Unable to remove business logo"));
  }
}
