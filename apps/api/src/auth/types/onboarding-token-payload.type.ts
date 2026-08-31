export type OnboardingTokenPayload = {
  sub: string;
  email: string;
  type: "onboarding";
  version: number;
};
